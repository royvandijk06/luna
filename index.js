#!/usr/bin/env node

const srcPath = process.argv[2] || process.cwd() || __dirname;
const debug = true;
if (debug) { console.log({ srcPath }); }

const { basename, resolve, relative, dirname, extname } = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const { readFile, writeFile, stat } = require("fs/promises");
const AST = require("acorn-loose");
const astWalk = require("acorn-walk").fullAncestor;
const ejs = require("ejs");
const fetch = require("node-fetch");
const glob = require("glob");
const randomColor = require("randomcolor");
const scan = require("scope-analyzer");

const depsCache = {};

function findReferences(node) {
    if (!node) {
        if (debug) { console.log(new Error("No node")); }
        return [];
    }
    if (node.type !== "Identifier") {
        // if (debug) { console.log(new Error("Not an identifier"), node); }
        return [];
    }
    // console.log({ node });
    let binding = scan.getBinding(node);
    if (!binding) {
        // console.log("NO BINDING", { node });
        return [];
    }
    let notItself = (ref) => !["type", "start", "end"].every((k) => ref[k] === node[k]);
    return binding.getReferences().filter(notItself);
}

/* Possibilities:
 * 1. Library is loaded into a single variable => variable = library name
 * 2. Library is loaded destructively into multiple objects => require(...) = library name
 * 3. After library is loaded, it gets instantiated
 */
function discoverAPI(ast, parent, _api = {}) {
    let api = _api;
    let addToAPI = (name, node) => {
        api[name] = api[name] || {};
        api[name].name = name;
        api[name].nodes = (api[name].nodes || []).concat([node]);
        for (let ref of findReferences(node)) {
            api[name].children = discoverAPI(ast, ref.parent, api[name].children);
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
        for (let ref of findReferences(parent.id)) {
            api = discoverAPI(ast, ref.parent, api);
        }
    } else if (parent.type === "NewExpression") { // new instance of library
        if (parent.parent.id) { // instance assigned to a variable
            addToAPI("(instance)", parent.parent.id);
        } else if (parent.parent.left && parent.parent.left.property && !parent.parent.left.computed) { // instance assigned to a property
            addToAPI("(instance)", parent.parent.left.property);
        }
    } else {
        // console.log("CANNOT FIND API", { parent });
    }
    return api;
}

// function findCallSource(node) {
//     let source = null;
//     let predecessor = node.parent;
//     while (!source && predecessor) {
//         if (predecessor.type === "FunctionDeclaration" || predecessor.type === "VariableDeclarator" || predecessor.type === "Program") {
//             source = predecessor;
//         }
//         predecessor = predecessor.parent;
//     }
//     return source;
// }

function findCallSource(node) {
    let source = null;
    let predecessor = node.parent;
    while (!source && predecessor) {
        if (predecessor.type === "Program") {
            source = predecessor;
        } else if (predecessor.type === "BlockStatement") {
            if (predecessor.parent.parent.type === "VariableDeclarator") { // function assigned to a variable
                source = predecessor.parent.parent;
            } else if (predecessor.parent.type === "FunctionDeclaration") { // function with name
                source = predecessor.parent;
            } else if (predecessor.parent.type === "FunctionExpression") { // nameless function
                source = predecessor.parent;
            }
        }
        predecessor = predecessor.parent;
    }
    return source;
}

function findCallDefinition(node) {
    if (node.callee.type === "FunctionExpression") {
        return node.callee;
    }
    for (let ref of findReferences(node.callee)) {
        if (ref.parent.type === "FunctionDeclaration" || ref.parent.type === "VariableDeclarator") {
            return ref.parent;
        }
    }
    return null;
}

async function getDependencies(name, version) {
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
    // let deps = { ...dependencies, ...devDependencies };
    // eslint-disable-next-line prefer-object-spread
    let deps = Object.assign({}, dependencies, devDependencies);

    // for (let dep in deps) {
    await Promise.all(Object.keys(deps).map(async(dep) => {
        let version = deps[dep].replace(/^\^/, ""); // TODO: https://stackoverflow.com/a/64990875/4356020
        node_modules[dep] = {
            version,
            "dependencies": await getDependencies(dep, version),
        };
        if (Object.keys(node_modules[dep].dependencies).length === 0) {
            delete node_modules[dep].dependencies;
        }
    }));
    // }

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
        if (stderr) {
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
        "cy":         resolve(__dirname, "assets", "cytoscape.min.js"),
        "cyCollapse": resolve(__dirname, "assets", "cytoscape-expand-collapse.js"),
        "dagre":      resolve(__dirname, "assets", "dagre.js"),
        "cyDagre":    resolve(__dirname, "assets", "cytoscape-dagre.js"),
        "cySetup":    resolve(__dirname, "assets", "cytoscape-setup.js"),
        "css":        resolve(__dirname, "assets", "stylesheet.css"),
        "template":   resolve(__dirname, "assets", "template.ejs"),
        "loader":     resolve(__dirname, "assets", "loader.svg"),
        "output":     resolve(outputPath),
    };
    let title = `${data.name || paths.output}${data.version ? `@${data.version}` : ""}`;
    let html = await ejs.renderFile(paths.template, { title, paths, "data": data.data });
    return writeFile(resolve(outputPath, "./luna.html"), html);
}

(async function main() {
    let getFiles = promisify(glob);
    // all javascript files in the project (excluding node_modules)
    let pattern = resolve(`${srcPath}/{,!(node_modules)/**/}*.{js,mjs}`).replace(/\\/g, "/");
    let srcFiles = (await getFiles(pattern)).map((f) => resolve(f));
    let { name, version, devDependencies, dependencies, main } = JSON.parse(await readFile(resolve(srcPath, "./package.json"), "utf8"));
    let hasNodeModules = await stat(resolve(srcPath, "./node_modules")).then(() => true)
        .catch(() => false);
    let node_modules = await getNodeModules(hasNodeModules, dependencies, devDependencies);
    let externalLibs = Object.keys(dependencies || {}).concat(Object.keys(devDependencies || {}));
    let libs = {};
    let calls = {};

    for (const file of srcFiles) {
        try {
            const code = await readFile(file);
            const ast = AST.parse(code, { "ecmaVersion": "latest", "sourceType": "module" });

            scan.createScope(ast, ["module", "require", "exports", "__dirname", "__filename"]);
            scan.crawl(ast);

            let libsInFile = {};
            let saveLib = async(libName, parent) => {
                libsInFile[libName] = libName.toString().toLowerCase()
                    .endsWith(".json") ? {} : discoverAPI(ast, parent); // API of lib (don't find API of json files)
            };

            calls[file] = {};
            let saveCall = async(source, target, node) => {
                if (!source || !target) {
                    return;
                }
                // let parentPath = dirname(file);
                // eslint-disable-next-line no-nested-ternary
                let sourceLabel = source.type === "Program" ? "(toplevel)" : (source.id ? source.id.name : "(anonymous)");
                let sourceId = `${sourceLabel}-${source.start}-${source.end}`;
                let targetLabel = target.id ? target.id.name : "(anonymous)";
                let targetId = `${targetLabel}-${target.start}-${target.end}`;
                let edgeId = `${relative(srcPath, file)} | ${sourceId} -> ${targetId}`;

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
                        "type":   "Function call",
                    },
                };
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

            astWalk(ast, (node, parents) => {
                let parent = parents[parents.length - 2];
                if (node.type === "ImportDeclaration") {
                    let libName = node.source.value;
                    if (!libName) {
                        console.error("Unable to determine library name 1 (skipping)", node, JSON.stringify(node, null, 2));
                        return;
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
                            console.error("Unable to determine library name 2 (skipping)", node, JSON.stringify(node, null, 2));
                            return;
                        }
                        libName = libName.toString();
                        if (libName.includes(srcPath)) { // fix path notation
                            libName = resolve(libName);
                        }
                        // if (libName.startsWith(".")) { // relative to absolute path
                        //     libName = resolve(file, libName);
                        // }
                        saveLib(libName, parent);
                    }
                }
            });
            libs[file] = libsInFile;
        } catch (e) {
            console.error(`Unable to parse "${file}": ${e}`);
            console.log(e);
            continue;
        }
    }

    if (debug) {
        console.log(JSON.stringify(calls, null, 2));
    }

    // GROUPS
    let treeData = [
        { "data": { "label": "Source Code", "color": "#fff", "id": "files", "group": true } },
        { "data": { "label": "Libraries", "color": "#fff", "id": "libs", "group": true } },
        { "data": { "label": "Unused", "color": "#fff", "parent": "libs", "id": "unused", "group": true } },
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
    if (debug) { console.log({ libSet }); }
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
            let parentParentFolder = basename(dirname(dir));
            let isParentRoot = relative(srcPath, dirname(dir)) === "";
            // group
            treeData.push({
                "data": {
                    "label":  `/${parentFolder}`,
                    "group":  true,
                    "color":  "#fff",
                    "parent": isParentRoot ? "files" : parentParentFolder,
                    "id":     dir,
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
                "parent":   isRootFile ? "files" : parentPath,
                "label":    fileName,
                "isMain":   main ? resolve(file) === resolve(srcPath, main) : false,
                "group":    true,
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
                let srcFile = srcFiles.find((f) => f === internalPath || f === altInternalPath);
                isInternalDep = Boolean(srcFile);
                if (isInternalDep) {
                    let fileId = relative(srcPath, srcFile);
                    id = fileId;
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
                        "isData":  libName.toLocaleLowerCase().endsWith(".json"), // weak detection
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
                            "source": fileId,
                            "target": `${libName} | ${name}`,
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
    // console.log({ node_modules });

    renderOutput(srcPath, {
        name,
        version,
        "data": treeData,
    });
})();
