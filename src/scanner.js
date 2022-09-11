const { basename, dirname, extname, relative, resolve } = require("path");
const { constructString, constructTemplateLiteral, findReferences } = require("./common");
const { extractCalls } = require("./call-graph");
const { extractLibs } = require("./library-api");
const { generateFlatAST } = require("flast");
const { getNodeModules } = require("./dependency-graph");
const { promisify } = require("util");
const { readFile, stat } = require("fs/promises");
const glob = require("glob");
const randomColor = require("randomcolor");

/**
 * https://github.com/eslint/eslint/blob/b93af98b3c417225a027cabc964c38e779adb945/lib/linter/linter.js#L718
 * Strips Unicode BOM from a given text.
 * @param {string} text A text to strip.
 * @returns {string} The stripped text.
 */
function stripUnicodeBOM(text) {
    /*
     * Check Unicode BOM.
     * In JavaScript, string data is stored as UTF-16, so BOM is 0xFEFF.
     * http://www.ecma-international.org/ecma-262/6.0/#sec-unicode-format-control-characters
     */
    if (text.charCodeAt(0) === 0xFEFF) {
        return text.slice(1);
    }
    return text;
}

async function scan(srcPath, dependencies, devDependencies, main) {
    let getFiles = promisify(glob);
    // all javascript files in the project (excluding node_modules)
    let pattern = resolve(`${srcPath}/{,!(node_modules)/**/}*.{js,mjs}`).replace(/\\/g, "/");
    let srcFiles = (await getFiles(pattern)).map((f) => resolve(f));
    let hasNodeModules = await stat(resolve(srcPath, "./node_modules")).then(() => true)
        .catch(() => false);
    let node_modules = await getNodeModules(srcPath, hasNodeModules, dependencies, devDependencies);
    let externalLibs = Object.keys(dependencies || {}).concat(Object.keys(devDependencies || {}));

    let srcContents = {};
    let libs = {};
    let calls = {};

    for (const file of srcFiles) {
        // if (file.includes("assets")) { // TODO: REMOVE THIS!
        //     continue;
        // }
        try {
            const code = await readFile(file);
            // https://github.com/eslint/eslint/blob/b93af98b3c417225a027cabc964c38e779adb945/lib/linter/linter.js#L779
            const textToParse = stripUnicodeBOM(code.toString()).replace(/^#!([^\r\n]+)/u, (match, captured) => `//${captured}`);
            const ast = generateFlatAST(textToParse, {
                "includeSrc": false,
                "parseOpts":  { "ecmaVersion": "latest", "sourceType": "module" },
            });

            srcContents[file] = code.toString();
            calls[file] = extractCalls(ast, file, srcPath);
            libs[file] = extractLibs(ast, file, srcPath);
        } catch (err) {
            console.error(`Unable to parse "${file}":`, err);
            continue;
        }
    }

    if (global.debug) {
        console.log("FUNCTION CALLS\n", calls);
    }

    // GROUPS
    let lunaData = [
        { "data": { "label": "Source Code", "color": "#fff", "id": "files", "group": true } },
        { "data": { "label": "Libraries", "color": "#fff", "id": "libs", "group": true } },
        { "data": { "label": "Development", "color": "#fff", "parent": "libs", "id": "unused", "group": true } },
        { "data": { "label": "Internal", "color": "#fff", "parent": "libs", "id": "internal", "group": true } },
        { "data": { "label": "External", "color": "#fff", "parent": "libs", "id": "external", "group": true } },
        { "data": { "label": "Dependency Tree", "color": "#fff", "id": "deps", "group": true } },
    ];

    // COLORS
    let libSet = Array.from(new Set(Object.values(libs).map((lib) => Object.keys(lib))
        .flat()
        .concat(Object.keys(node_modules))));
    if (global.debug) {
        console.log("LIBRARIES\n", libSet);
    }
    let nLibs = libSet.length;
    let randomColors = randomColor({
        "count":      nLibs,
        "luminosity": "light",
    });
    let colors = {};

    // FILES & LIBRARIES
    for (let file in libs) {
        let parentPath = dirname(file);
        let isRootFile = relative(srcPath, parentPath) === "";
        let fileId = relative(srcPath, file);
        let fileName = basename(file);
        let fileExt = extname(file);

        // eslint-disable-next-line no-loop-func
        let addParentGroup = (dir) => {
            let parentFolder = basename(dir);
            let parentParentFolder = dirname(dir);
            let isParentRoot = relative(srcPath, dirname(dir)) === "";
            // group
            lunaData.push({
                "data": {
                    "label":    `/${parentFolder}`,
                    "group":    true,
                    "color":    "#fff",
                    "parent":   isParentRoot ? "files" : parentParentFolder,
                    "id":       dir,
                    "isFolder": true,
                },
            });
            if (!isParentRoot) {
                addParentGroup(dirname(dir));
            }
        };

        if (!isRootFile) {
            addParentGroup(dirname(file));
        }

        // node (file)
        lunaData.push({
            "data": {
                "id":       fileId,
                "isData":   fileExt === ".json",
                "color":    "#fff",
                "filePath": file,
                "size":     {
                    "loc":   srcContents[file].split("\n").length,
                    "chars": srcContents[file].length,
                },
                "parent": isRootFile ? "files" : parentPath,
                "label":  fileName,
                "isMain": main ? resolve(file) === resolve(srcPath, main) : false,
                "group":  true,
            },
        });

        for (let libName in libs[file]) {
            let id = libName;
            let isInternalDep = false;
            let version = "";
            let tags = [];
            if (node_modules[libName]) {
                ({ version, tags } = node_modules[libName]);
                id = `${libName}@${version}`;
            } else {
                let internalPath = resolve(dirname(file), libName);
                let ext = extname(internalPath);
                let altInternalPath = ext ? internalPath.replace(ext, "") : `${internalPath}.js`; // extension may be included or omitted (assumption: .js)
                let indexInternalPath = ext ? null : resolve(internalPath, "index.js"); // require(x) <=> require(x/index.js)

                // If this internal dependency is among src files, it is a file node.
                let srcFile = srcFiles.find((f) => f === internalPath || f === altInternalPath || f === indexInternalPath);
                isInternalDep = Boolean(srcFile);
                if (isInternalDep) {
                    let fileId = relative(srcPath, srcFile);
                    id = fileId;
                }
                if (id.includes(srcPath)) {
                    // correct path notation
                    id = relative(srcPath, id);
                    if (id === "") {
                        id = ".";
                    }
                }
            }
            if (!colors[id]) {
                colors[id] = randomColors.pop();
            }

            if (!isInternalDep) {
                // node
                lunaData.push({
                    "data": {
                        id,
                        "isData":  libName.toLowerCase().endsWith(".json"), // sufficient detection?
                        "library": { "name": libName, version, tags },
                        "color":   colors[id],
                        "parent":  externalLibs.includes(libName) ? "external" : "internal", // group: external or internal
                        "label":   id,
                        "group":   true,
                    },
                });
            }

            // eslint-disable-next-line no-loop-func
            let recurseApi = (libName, api, source) => {
                for (let name in api) {
                    if (source) {
                        // node
                        lunaData.push({
                            "data": {
                                "parent": libName,
                                "id":     `${libName} | ${source}`,
                                "color":  "#fff",
                                "label":  source,
                                "type":   "API",
                            },
                        });
                        // edge
                        lunaData.push({
                            "data": {
                                "parent": libName,
                                "id":     `${libName} | ${source} -> ${name}`,
                                "color":  "#fff",
                                "source": `${libName} | ${source}`,
                                "target": `${libName} | ${name}`,
                            },
                        });
                    }
                    // node
                    lunaData.push({
                        "data": {
                            "parent": libName,
                            "id":     `${libName} | ${name}`,
                            "color":  "#fff",
                            "label":  name,
                            "type":   "API",
                        },
                    });
                    // edge
                    // let lunaDataIds = lunaData.map((e) => e.data.id);
                    // let sourceId = api[name].sourceIds.find((id) => lunaDataIds.includes(id));
                    let sourceId = api[name].sourceIds.find((id) => calls[file] && calls[file][id]);
                    if (name === "(reference)\nas \"glob\"") {
                        console.log("sourceId", sourceId);
                        console.log("calls[file]", calls[file]);
                        console.log("api[name].sourceIds", api[name].sourceIds);
                    }
                    lunaData.push({
                        "data": {
                            "id":        `${sourceId || fileId} -> ${name}`,
                            "color":     "#fff",
                            // "source": fileId,
                            // "source":     lunaData.find((e) => e.data.id === api[name].sourceId) ? api[name].sourceId : fileId, // Workaround, TODO: Fix this
                            "source":    sourceId || fileId, // Workaround, TODO: Fix this
                            "target":    `${libName} | ${name}`,
                            "sourceIds": api[name].sourceIds,
                            "nodes":     api[name].nodes.map((e) => ({
                                "type":  e.type,
                                "start": e.start,
                                "end":   e.end,
                            })),
                        },
                    });
                    recurseApi(libName, api[name].children, name);
                }
            };

            if (Object.keys(libs[file][libName]).length > 0) {
                recurseApi(id, libs[file][libName]);
            } else {
                // edge
                lunaData.push({
                    "data": {
                        "id":     `${fileId} -> ${id}`,
                        "color":  colors[id] || "#fff",
                        "source": fileId,
                        "target": id,
                    },
                });
            }
        }
    }

    // CALLS
    // Workaround: Turn combined call nodes and API nodes
    // TODO: do proper export tracking per file
    for (let file in calls) {
        for (let id in calls[file]) {
            let node = calls[file][id];
            if (!node) {
                continue;
            }
            let apiID = `${node.data.parent} | ${node.data.label}`;
            for (let i = 0; i < lunaData.length; i++) {
                // if it finds a call being used as API, turn it into an API node
                if (lunaData[i] && lunaData[i].data.id === apiID) {
                    lunaData[i] = null;
                    calls[file][id].data.type = "API";
                    calls[file][id].data.id = apiID;
                    calls[file][apiID] = calls[file][id];
                    delete calls[file][id];
                    for (let key of Object.keys(calls[file]).filter((e) => e.includes(id))) {
                        // eslint-disable-next-line max-depth
                        if (calls[file][key].data.target === id) {
                            calls[file][key].data.target = apiID;
                        }
                        // eslint-disable-next-line max-depth
                        if (calls[file][key].data.source === id) {
                            calls[file][key].data.source = apiID;
                        }
                        calls[file][key].data.id = calls[file][key].data.id.replace(id, apiID);
                        calls[file][calls[file][key].data.id] = calls[file][key];
                        delete calls[file][key];
                    }
                    for (let j = 0; j < lunaData.length; j++) {
                        // eslint-disable-next-line max-depth
                        if (lunaData[j] && lunaData[j].data.sourceIds && lunaData[j].data.sourceIds.includes(id)) {
                            lunaData[j].data.sourceIds = lunaData[j].data.sourceIds.map((e) => (e === id ? apiID : e));
                        }
                        // eslint-disable-next-line max-depth
                        if (lunaData[j] && lunaData[j].data.target === id) {
                            lunaData[j].data.target = apiID;
                        }
                        // eslint-disable-next-line max-depth
                        if (lunaData[j] && lunaData[j].data.source === id) {
                            lunaData[j].data.source = apiID;
                        }
                    }

                    // calls[file] = JSON.parse(JSON.stringify(calls[file]).replaceAll(JSON.stringify(id).slice(1, -1), JSON.stringify(apiID).slice(1, -1)));
                    break;
                }
            }
        }
    }
    lunaData = lunaData.filter((e) => e);
    lunaData.push(...Object.values(calls).flat()
        .map((e) => Object.values(e))
        .flat());

    // DEPENDENCY TREE
    let traverseTree = (node, parent) => {
        for (let libName in node) {
            let lib = node[libName];
            let { version, tags } = lib;
            tags = tags || [];
            let id = `${libName}@${version}`;
            if (!colors[id]) {
                colors[id] = colors[parent] || randomColors.pop();
            }
            if (!parent && !lunaData.find((n) => n.data.id === id)) { // if not already in tree
                // node
                lunaData.push({
                    "data": {
                        id,
                        "library": { "name": libName, version, tags },
                        "color":   colors[id],
                        "parent":  "unused", // group
                        "label":   id,
                        "group":   true,
                    },
                });
            }
            if (parent) {
                // node
                lunaData.push({
                    "data": {
                        id,
                        "library": { "name": libName, version, tags },
                        "color":   colors[id],
                        "parent":  "deps", // group
                        "label":   id,
                    },
                });
                // edge
                lunaData.push({
                    "data": {
                        "id":     `${parent} -> ${id}`,
                        "color":  colors[id],
                        "source": parent,
                        "target": id,
                    },
                });
            }
            if (lib.dependencies) {
                traverseTree(lib.dependencies, id);
            }
        }
    };
    traverseTree(node_modules);

    if (global.debug) {
        console.log("DEPENDENCIES OF LIBRARIES (NODE_MODULES)\n", node_modules);
    }

    return lunaData;
}

module.exports = { scan, constructString, constructTemplateLiteral };
exports.findReferences = findReferences;
