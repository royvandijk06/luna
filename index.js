#!/usr/bin/env node
/* eslint-disable max-depth */

const srcPath = process.argv[2] || process.cwd();
if (!srcPath) {
    throw new Error("No project path specified");
}

const { basename, dirname, extname, relative, resolve } = require("path");
const { exec } = require("child_process");
const { generateFlatAST } = require("flast");
const { promisify } = require("util");
const { readFile, writeFile, stat } = require("fs/promises");
const ejs = require("ejs");
const fetch = require("node-fetch");
const glob = require("glob");
const pkg = require(resolve(srcPath, "./package.json"));
const randomColor = require("randomcolor");

const depsCache = {};
const configDefault = {
    "debug":      false,
    "components": {
        "callGraph":      true,
        // "callGraph":      false,
        // "dependencyTree": true,
        "dependencyTree": false,
        // "libraryAPI":     true,
        "libraryAPI":     false,
    },
};
const config = { ...configDefault, ...pkg.luna || {} };
config.debug = process.argv[3] === "1" || process.argv[3] === "true" ? true : config.debug;

function findReferences(node) {
    if (!node) {
        if (config.debug) { console.log(new Error("No node")); }
        return [];
    }

    let references = [].concat(node.references || [], node.declNode ? [node.declNode] : []);
    let refIds = [node.nodeId];
    return references.filter((n) => {
        let res = !refIds.includes(n.nodeId);
        refIds.push(n.nodeId);
        return res;
    });
}

/* Possibilities:
 * 1. Library is loaded into a single variable => variable = library name
 * 2. Library is loaded destructively into multiple objects => require(...) = library name
 * 3. After library is loaded, it gets instantiated
 */
// Workaround, TODO: Fix endless cycle
let nodesSeen = [];
function discoverAPI(parent, _api = {}) {
    if (!config.components.libraryAPI) {
        return {};
    }
    let api = _api;
    if (nodesSeen.includes(parent.nodeId)) {
        return api;
    }
    nodesSeen.push(parent.nodeId);

    let addToAPI = (name, node) => {
        // eslint-disable-next-line no-use-before-define
        let source = findCallSource(node);
        // eslint-disable-next-line no-nested-ternary
        let sourceLabel = source.type === "Program" ? "(toplevel)" : (source.id ? source.id.name : (source.key ? source.key.name : "(anonymous)"));
        let sourceId = `${sourceLabel}-${source.start}-${source.end}`;
        api[name] = api[name] || {};
        api[name].name = name;
        api[name].sourceId = sourceId;
        api[name].nodes = (api[name].nodes || []).concat([node]);
        for (let ref of findReferences(node)) {
            api[name].children = discoverAPI(ref.parentNode, api[name].children);
        }
    };

    if (parent.property && parent.computed === false) { // property of object
        addToAPI(parent.property.name, parent.property);
    } else if (parent.id && parent.id.properties) { // destructuring
        let props = parent.id.properties;
        for (const prop of props) {
            // addToAPI(prop.value?.name || prop.key.name, prop.value || prop.key); // choose value over key if it exists
            addToAPI((prop.value && prop.value.name) || prop.key.name, prop.value || prop.key); // choose value over key if it exists
            if (prop.value && prop.value.properties) {
                // TODO: support nested destructuring
            }
        }
    } else if (parent.id) { // variable name
        let added = false;
        for (let ref of findReferences(parent.id)) {
            if (ref.parentNode.type === "CallExpression" && !added) { // lib variable is a function
                addToAPI(`(reference)\nas "${parent.id.name}"`, parent.id);
                added = true;
            }
            api = discoverAPI(ref.parentNode, api);
        }
    } else if (parent.type === "NewExpression") { // new instance of library
        if (parent.parentNode.id) { // instance assigned to a variable
            addToAPI("(instance)", parent.parentNode.id);
        } else if (parent.parentNode.left && parent.parentNode.left.property && !parent.parentNode.left.computed) { // instance assigned to a property
            addToAPI("(instance)", parent.parentNode.left.property);
        }
    } else if (config.debug) {
        console.warn("Could not find API for", parent);
    }
    return api;
}

function findCallSource(node) {
    let betterScope = node.scope;
    while (!betterScope.type.toLowerCase().includes("function") && !betterScope.type.toLowerCase().includes("module") && betterScope.upper) {
        betterScope = betterScope.upper;
    }
    return betterScope.block;
}

// @returns FunctionExpression|FunctionExpression|FunctionDeclaration
function findCallDefinition(node) {
    if (node.callee.type === "FunctionExpression") {
        if (node.callee.parentNode.type === "MethodDefinition") { // method
            return node.callee.parentNode;
        }
        return node.callee;
    }
    if (node.callee.type === "Identifier" || node.callee.type === "MemberExpression") {
        let id = node.callee.type === "MemberExpression" ? node.callee.property : node.callee;
        for (let ref of findReferences(id)) { // findReferences once again lacking...
            if (ref.parentNode.type === "FunctionDeclaration" || ref.parentNode.type === "VariableDeclarator" || ref.parentNode.type === "MethodDefinition") {
                return ref.parentNode;
            }
        }
    }
    if (node.callee.type === "MemberExpression" && node.callee.object.type === "ThisExpression") {
        let classBody = null;
        let predecessor = node.parentNode;
        while (predecessor && !classBody) {
            if (predecessor.type === "ClassBody") {
                classBody = predecessor;
                break;
            }
            predecessor = predecessor.parentNode;
        }
        if (classBody) {
            for (let method of classBody.body) {
                if (method.type !== "MethodDefinition") {
                    continue;
                }
                if (method.key.name === node.callee.property.name) {
                    return method;
                }
            }
        }
    }
    if (node.arguments && node.arguments.length > 0) {
        for (let arg of node.arguments) {
            if (arg.type === "FunctionExpression") {
                return arg;
            }
        }
    }
    return null;
}

async function getDependencies(name, version) {
    if (!config.components.dependencyTree) {
        return {};
    }
    if (depsCache[`${name}@${version}`]) {
        return depsCache[`${name}@${version}`];
    }

    let url = `https://registry.npmjs.org/${name}/${version}`;
    let response = null;
    let attempts = 1;
    while (!response && attempts <= 6) {
        response = await fetch(url).catch((err) => {
            console.error(err);
            return null;
        });
        if (!response) {
            let delay = attempts * 6000;
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        attempts++;
    }
    if (!response) {
        throw new Error(`Unable to fetch ${url}`);
    }
    let { dependencies } = await response.json();
    // eslint-disable-next-line no-use-before-define
    let parsedDependencies = await parseDependencies(dependencies);
    depsCache[`${name}@${version}`] = parsedDependencies;
    return parsedDependencies;
}

async function parseDependencies(dependencies, devDependencies = {}) {
    let node_modules = {};
    let deps = { ...dependencies, ...devDependencies };

    for (let dep in deps) {
        let version = deps[dep].replace(/^\^/, ""); // TODO: https://stackoverflow.com/a/64990875/4356020
        node_modules[dep] = {
            version,
            "dependencies": await getDependencies(dep, version),
        };
        if (Object.keys(node_modules[dep].dependencies).length === 0) {
            delete node_modules[dep].dependencies;
        }
    }

    return node_modules;
}

async function getNodeModules(useLocalDependencies, dependencies, devDependencies) {
    if (!useLocalDependencies && !dependencies) {
        // throw new Error("No dependencies found");
        return {};
    }

    if (useLocalDependencies) {
        let execute = promisify(exec);

        let { stdout, stderr } = await execute("npm ls --all --json", { "cwd": srcPath }).catch((stderr) => ({ stderr }));
        // if (stderr) { // This catches warnings too
        if (!stdout) {
            throw new Error(stderr);
            // return parseDependencies(dependencies, devDependencies);
        }

        return JSON.parse(stdout).dependencies;
    }

    return parseDependencies(dependencies, devDependencies);
}

function constructTemplateLiteral(node) {
    let str = "";
    // let nodes = [...node.quasis, ...node.expressions].sort((a, b) => a.start - b.start);
    let nodes = [].concat(node.quasis, node.expressions).sort((a, b) => a.start - b.start);
    for (let i = 0; i < nodes.length; i++) {
        let node = nodes[i];
        // eslint-disable-next-line no-use-before-define
        str += constructString(node);
    }
    return str;
}

function constructString(node) {
    let str = "";

    switch (node.type) {
        case "Literal":
            str = node.value;
            break;
        case "TemplateLiteral":
            str = constructTemplateLiteral(node);
            break;
        case "Identifier":
            if (node.name === "__dirname") {
                str = srcPath;
            } else {
                str = `#${node.name}#`; // variable or function
            }
            break;
        case "BinaryExpression":
            str = `${constructString(node.left)}${constructString(node.right)}`;
            break;
        case "TemplateElement":
            str = node.value.raw;
            break;
        default:
            break;
    }

    return str;
}

async function renderOutput(outputPath, data) {
    let paths = {
        "cy":            resolve(__dirname, "assets", "js", "cytoscape.min.js"),
        "cyCollapse":    resolve(__dirname, "assets", "js", "cytoscape-expand-collapse.js"),
        "elk":           resolve(__dirname, "assets", "js", "elk.bundled.js"),
        "cyElk":         resolve(__dirname, "assets", "js", "cytoscape-elk.js"),
        "cola":          resolve(__dirname, "assets", "js", "cola.min.js"),
        "cyCola":        resolve(__dirname, "assets", "js", "cytoscape-cola.js"),
        "shim":          resolve(__dirname, "assets", "js", "shim.min.js"),
        "layoutBase":    resolve(__dirname, "assets", "js", "layout-base.js"),
        "coseBase":      resolve(__dirname, "assets", "js", "cose-base.js"),
        "cyCoseBilkent": resolve(__dirname, "assets", "js", "cytoscape-cose-bilkent.js"),
        "cySetup":       resolve(__dirname, "assets", "js", "cytoscape-setup.js"),
        "stylesheet":    resolve(__dirname, "assets", "css", "stylesheet.css"),
        "fontawesome":   resolve(__dirname, "assets", "css", "fontawesome.min.css"),
        "regularFont":   resolve(__dirname, "assets", "css", "regular.min.css"),
        "solidFont":     resolve(__dirname, "assets", "css", "solid.min.css"),
        "template":      resolve(__dirname, "assets", "html", "template.ejs"),
        "output":        resolve(outputPath),
    };
    let title = `${data.name || paths.output}${data.version ? `@${data.version}` : ""}`;
    let html = await ejs.renderFile(paths.template, { config, title, paths, "data": data.data }, { "rmWhitespace": true });
    return writeFile(resolve(outputPath, "./luna.html"), html);
}

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

(async function main() {
    if (config.debug) { console.log({ srcPath }); }

    let getFiles = promisify(glob);
    // all javascript files in the project (excluding node_modules)
    let pattern = resolve(`${srcPath}/{,!(node_modules)/**/}*.{js,mjs}`).replace(/\\/g, "/");
    let srcFiles = (await getFiles(pattern)).map((f) => resolve(f));
    let { name, version, devDependencies, dependencies, main } = pkg;
    let hasNodeModules = await stat(resolve(srcPath, "./node_modules")).then(() => true)
        .catch(() => false);
    let node_modules = await getNodeModules(hasNodeModules, dependencies, devDependencies);
    let externalLibs = Object.keys(dependencies || {}).concat(Object.keys(devDependencies || {}));
    let srcContents = {};
    let libs = {};
    let calls = {};

    for (const file of srcFiles) {
        try {
            const code = await readFile(file);
            srcContents[file] = code.toString();
            // https://github.com/eslint/eslint/blob/b93af98b3c417225a027cabc964c38e779adb945/lib/linter/linter.js#L779
            const textToParse = stripUnicodeBOM(code.toString()).replace(/^#!([^\r\n]+)/u, (match, captured) => `//${captured}`);
            const ast = generateFlatAST(textToParse, {
                "includeSrc": false,
                "parseOpts":  { "ecmaVersion": "latest", "sourceType": "module" },
            });

            let libsInFile = {};
            let saveLib = async(libName, parent) => {
                libsInFile[libName] = libName.toString().toLowerCase()
                    .endsWith(".json") ? {} : discoverAPI(parent); // API of lib (don't find API of json files)
            };

            calls[file] = {};
            let saveCall = (source, target, node) => {
                if (!config.components.callGraph) {
                    return;
                }
                if (!source || !target) {
                    return;
                }

                // // TODO: Support imports
                // let isLibCall = target.init && target.init.callee && target.init.callee.name === "require";

                // eslint-disable-next-line no-nested-ternary
                let sourceLabel = source.type === "Program" ? "(toplevel)" : (source.id ? source.id.name : (source.key ? source.key.name : "(anonymous)"));
                let sourceId = `${sourceLabel}-${source.start}-${source.end}`;
                // eslint-disable-next-line no-nested-ternary
                let targetLabel = target.id ? target.id.name : (target.key ? target.key.name : "(anonymous)");
                let targetId = `${targetLabel}-${target.start}-${target.end}`;
                let edgeId = `${relative(srcPath, file)} | ${sourceId} -> ${targetId}`;

                if (config.debug && !sourceLabel) {
                    console.warn("sourceLabel is empty", source);
                }
                if (config.debug && !targetLabel) {
                    console.warn("targetLabel is empty", target);
                }

                let caller = {
                    "type":  node.type,
                    "start": node.start,
                    "end":   node.end,
                };

                // node (source)
                calls[file][sourceId] = {
                    "data": {
                        caller,
                        "label":  sourceLabel,
                        "color":  "#fff",
                        "id":     sourceId,
                        "parent": relative(srcPath, file), // TODO: parent
                        "type":   source.type === "ClassDeclaration" ? "Class" : "Function call",
                    },
                };

                // if (isLibCall) {
                //     // 'require' only takes 1 argument: https://nodejs.org/api/modules.html#requireid
                //     let argNode = target.init.arguments[0];
                //     let libName = constructString(argNode);
                //     if (debug && !libName) {
                //         console.warn("Unable to determine library name from require (skipping)", node);
                //         return;
                //     }
                //     libName = libName.toString();
                //     targetId = `${libName} | ${targetLabel}`;
                // } else {

                // node (target)
                calls[file][targetId] = {
                    "data": {
                        caller,
                        "label":  targetLabel,
                        "color":  "#fff",
                        "id":     targetId,
                        "parent": relative(srcPath, file), // TODO: parent
                        "type":   "Function call",
                    },
                };

                // }

                // edge
                calls[file][edgeId] = {
                    "data": {
                        caller,
                        "source": sourceId,
                        "target": targetId,
                        "color":  "#fff",
                        "id":     edgeId,
                    },
                };
            };

            for (let node of ast) {
                let parent = node.parentNode;
                if (node.type === "ImportDeclaration") {
                    let libName = node.source.value;
                    if (!libName) {
                        if (config.debug) {
                            console.warn("Unable to determine library name from import (skipping)", node);
                        }
                        continue;
                    }
                    saveLib(libName, parent);
                } else if (node.type === "CallExpression") {
                    // call -> findscope -> subroutine (source)
                    // /    -> findref -> definition (target)
                    let source = findCallSource(node);
                    let target = findCallDefinition(node);
                    saveCall(source, target, node);

                    if (node.callee.name === "require") {
                        // 'require' only takes 1 argument: https://nodejs.org/api/modules.html#requireid
                        let argNode = node.arguments[0];
                        let libName = constructString(argNode);
                        if (!libName) {
                            if (config.debug) {
                                console.warn("Unable to determine library name from require (skipping)", node);
                            }
                            continue;
                        }
                        libName = libName.toString();
                        if (libName.startsWith(".")) { // relative to absolute path
                            libName = resolve(dirname(file), libName);
                        }
                        if (libName.includes(srcPath)) { // fix path notation
                            libName = resolve(libName);
                        }
                        saveLib(libName, parent);
                    }
                } else if (node.type === "ClassDeclaration") {
                    for (let method of node.body.body) {
                        if (method.type === "MethodDefinition") {
                            saveCall(node, method, method);
                        }
                    }
                    // Add connection between class and the scope it is defined in?
                    // let source = findCallSource(node);
                    // saveCall(source, node, node);
                }
            }
            libs[file] = libsInFile;
        } catch (err) {
            console.error(`Unable to parse "${file}":`, err);
            continue;
        }
    }

    if (config.debug) {
        console.log("FUNCTION CALLS\n", calls);
    }

    // GROUPS
    let treeData = [
        { "data": { "label": "Source Code", "color": "#fff", "id": "files", "group": true } },
        { "data": { "label": "Libraries", "color": "#fff", "id": "libs", "group": true } },
        { "data": { "label": "Development", "color": "#fff", "parent": "libs", "id": "unused", "group": true } },
        { "data": { "label": "Internal", "color": "#fff", "parent": "libs", "id": "internal", "group": true } },
        { "data": { "label": "External", "color": "#fff", "parent": "libs", "id": "external", "group": true } },
        { "data": { "label": "Dependency Tree", "color": "#fff", "id": "deps", "group": true } },
        ...Object.values(calls).flat()
            .map((e) => Object.values(e))
            .flat(),
    ];

    // COLORS
    let libSet = Array.from(new Set(Object.values(libs).map((lib) => Object.keys(lib))
        .flat()
        .concat(Object.keys(node_modules))));
    if (config.debug) {
        console.log("LIBRARIES\n", libSet);
    }
    let nLibs = libSet.length; // number of libraries?
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
        // let parentFolder = basename(parentPath);

        let addParentGroup = (dir) => {
            let parentFolder = basename(dir);
            if (treeData.find((node) => node.data.id === parentFolder)) {
                return;
            }
            let parentParentFolder = dirname(dir);
            let isParentRoot = relative(srcPath, dirname(dir)) === "";
            // group
            treeData.push({
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

        // node
        treeData.push({
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
            if (node_modules[libName]) {
                ({ version } = node_modules[libName]);
                id = `${libName}@${version}`;
            } else {
                let internalPath = resolve(dirname(file), libName);
                let ext = extname(internalPath);
                let altInternalPath = ext ? internalPath.replace(ext, "") : `${internalPath}.js`; // sometimes the extension is missing, TODO: support folder/index.js

                // If this internal dependency is among src files, it is a file node.
                let srcFile = srcFiles.find((f) => f === internalPath || f === altInternalPath);
                isInternalDep = Boolean(srcFile);
                if (isInternalDep) {
                    let fileId = relative(srcPath, srcFile);
                    id = fileId;
                }
                if (id.includes(srcPath)) {
                    // fix path notation
                    id = relative(srcPath, id);
                }
            }
            if (!colors[id]) {
                colors[id] = randomColors.pop();
            }

            if (!isInternalDep) {
                // node
                treeData.push({
                    "data": {
                        id,
                        "isData":  libName.toLocaleLowerCase().endsWith(".json"), // weak detection?
                        "library": { "name": libName, version },
                        "color":   colors[id],
                        "parent":  externalLibs.includes(libName) ? "external" : "internal", // group: external or internal
                        "label":   id,
                        "group":   true,
                    },
                });
            }

            let recurseApi = (libName, api, source) => {
                for (let name in api) {
                    if (source) {
                        // node
                        treeData.push({
                            "data": {
                                "parent": libName,
                                "id":     `${libName} | ${source}`,
                                "color":  "#fff",
                                "label":  source,
                                "type":   "API",
                            },
                        });
                        // edge
                        treeData.push({
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
                    treeData.push({
                        "data": {
                            "parent": libName,
                            "id":     `${libName} | ${name}`,
                            "color":  "#fff",
                            "label":  name,
                            "type":   "API",
                        },
                    });
                    // edge
                    treeData.push({
                        "data": {
                            "id":     `${libName} -> ${name}`,
                            "color":  "#fff",
                            // "source": fileId,
                            "source": treeData.find((e) => e.data.id === api[name].sourceId) ? api[name].sourceId : fileId, // Workaround, TODO: Fix this
                            "target": `${libName} | ${name}`,
                            // TODO: swap source & target?
                        },
                    });
                    recurseApi(libName, api[name].children, name);
                }
            };

            if (Object.keys(libs[file][libName]).length > 0) {
                recurseApi(id, libs[file][libName]);
            } else {
                // edge
                treeData.push({
                    "data": {
                        "id":     `${fileId} -> ${id}`,
                        "color":  "#fff",
                        "source": fileId,
                        "target": id,
                    },
                });
            }
        }
    }

    // DEPENDENCY TREE
    let traverseTree = (node, parent) => {
        for (let libName in node) {
            let lib = node[libName];
            let { version } = lib;
            let id = `${libName}@${version}`;
            if (!colors[id]) {
                colors[id] = colors[parent] || randomColors.pop();
            }
            if (!parent && !treeData.find((n) => n.data.id === id)) { // if not already in tree
                // node
                treeData.push({
                    "data": {
                        id,
                        "library": { "name": libName, version },
                        "color":   colors[id],
                        "parent":  "unused", // group
                        "label":   id,
                        "group":   true,
                    },
                });
            }
            if (parent) {
                // node
                treeData.push({
                    "data": {
                        id,
                        "library": { "name": libName, version },
                        "color":   colors[id],
                        "parent":  "deps", // group
                        "label":   id,
                    },
                });
                // edge
                treeData.push({
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

    if (config.debug) {
        console.log("DEPENDENCIES OF LIBRARIES (NODE_MODULES)\n", node_modules);
    }

    renderOutput(srcPath, {
        name,
        version,
        "data": treeData,
    });
})();
