// #!/usr/bin/env node

const srcPath = process.argv[2] || process.cwd() || __dirname;
const debug = true;
if (debug) { console.log({ srcPath }); }

const { analyze } = require("eslint-scope");
const { basename, dirname, extname, relative, resolve } = require("path");
const { exec } = require("child_process");
const { latestEcmaVersion, parse } = require("espree");
const { promisify } = require("util");
const { readFile, writeFile, stat } = require("fs/promises");
const { Syntax, traverse } = require("estraverse");
const ejs = require("ejs");
const fetch = require("node-fetch");
const glob = require("glob");
const randomColor = require("randomcolor");

let depsCache = {};

function astNodeEquals(a, b) {
    return a.type === b.type && a.range[0] === b.range[0] && a.range[1] === b.range[1];
}

// function findReferences(node) {
//     if (!node) {
//         if (debug) { console.log(new Error("No node")); }
//         return [];
//     }
//     if (node.type !== "Identifier") {
//         // if (debug) { console.log(new Error("Not an identifier"), node); }
//         return [];
//     }
//     // console.log({ node });
//     let binding = scan.getBinding(node);
//     if (!binding) {
//         // console.log("NO BINDING", { node });
//         return [];
//     }
//     let notItself = (ref) => !astNodeEquals(ref, node);
//     return binding.getReferences().filter(notItself);
// }

/* Possibilities:
 * 1. Library is loaded into a single variable => variable = library name
 * 2. Library is loaded destructively into multiple objects => require(...) = library name
 * 3. After library is loaded, it gets instantiated
 */
function discoverAPI(currentScope, parent, _api = {}) {
    // return {};
    let api = _api;
    let addToAPI = (name, node) => {
        // eslint-disable-next-line no-use-before-define
        let source = findCallSource(node, currentScope);
        // eslint-disable-next-line no-nested-ternary
        let sourceLabel = source.type === Syntax.Program ? "(toplevel)" : (source.id ? source.id.name : (source.key ? source.key.name : "(anonymous)"));
        let sourceId = `${sourceLabel}-${source.start}-${source.end}`;
        api[name] = api[name] || {};
        api[name].name = name;
        api[name].sourceId = sourceId;
        api[name].nodes = (api[name].nodes || []).concat([node]);
        // // skip API discovery, if API was an object property (workaround for https://github.com/goto-bus-stop/scope-analyzer/issues/32)
        // if (node.parent.property && astNodeEquals(node.parent.property, node)) {
        //     return;
        // }
        // eslint-disable-next-line no-use-before-define
        let variable = findCorrespondingVariable(node, currentScope);
        if (variable) {
            for (let r of variable.references) {
                let ref = r.identifier;
                console.log(ref.parent);
                process.exit();
                if (astNodeEquals(ref.parent, parent)) { // cycle?
                    continue;
                }
                api[name].children = discoverAPI(currentScope, ref.parent, api[name].children);
            }
        } else if (debug) {
            console.warn("Could not find corresponding variable for", node);
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
        // eslint-disable-next-line no-use-before-define
        let variable = findCorrespondingVariable(parent.id, currentScope);
        if (variable) {
            for (let r of variable.references) {
                let ref = r.identifier;
                if (ref.parent.type === Syntax.CallExpression && !added) { // lib variable is a function
                    addToAPI(`(reference)\nas "${parent.id.name}"`, parent.id);
                    added = true;
                }
                api = discoverAPI(currentScope, ref.parent, api);
            }
        } else if (debug) {
            console.warn("Could not find corresponding variable for", parent.id);
        }
    } else if (parent.type === Syntax.NewExpression) { // new instance of library
        if (parent.parent.id) { // instance assigned to a variable
            addToAPI("(instance)", parent.parent.id);
        } else if (parent.parent.left && parent.parent.left.property && !parent.parent.left.computed) { // instance assigned to a property
            addToAPI("(instance)", parent.parent.left.property);
        }
    } else if (debug) {
        // console.log("CANNOT FIND API", { parent });
    }
    return api;
}

// function findCallSource(node) {
//     let source = null;
//     let predecessor = node.parent;
//     while (!source && predecessor) {
//         if (predecessor.type === Syntax.FunctionDeclaration || predecessor.type === Syntax.VariableDeclarator || predecessor.type === Syntax.Program) {
//             source = predecessor;
//         }
//         predecessor = predecessor.parent;
//     }
//     return source;
// }

function findCallSource(node, currentScope) {
    // let source = null;
    // let predecessor = node.parent;
    // while (!source && predecessor) {
    //     if (predecessor.type === Syntax.Program) {
    //         source = predecessor;
    //     } else if (predecessor.type === Syntax.BlockStatement) {
    //         if (predecessor.parent.parent.type === Syntax.VariableDeclarator) { // function assigned to a variable
    //             source = predecessor.parent.parent;
    //         } else if (predecessor.parent.type === Syntax.FunctionDeclaration) { // function with name
    //             source = predecessor.parent;
    //         } else if (predecessor.parent.type === Syntax.MethodDefinition) { // method
    //             source = predecessor.parent;
    //         } else if (predecessor.parent.type === Syntax.FunctionExpression) { // nameless function
    //             source = predecessor.parent;
    //             if (predecessor.parent.parent.type === Syntax.MethodDefinition) { // method
    //                 source = predecessor.parent.parent;
    //             // } else if (predecessor.parent.parent.type === Syntax.CallExpression) {
    //             //     source = findCallSource(predecessor.parent.parent);
    //             }
    //         } else if (predecessor.parent.type === Syntax.ArrowFunctionExpression) { // nameless arrow function
    //             source = predecessor.parent;
    //             // if (predecessor.parent.parent.type === Syntax.CallExpression) {
    //             //     source = findCallSource(predecessor.parent.parent);
    //             // }
    //         }
    //     }
    //     predecessor = predecessor.parent;
    // }
    // return source;

    let betterScope = currentScope;
    while (!betterScope.type.toLowerCase().includes("function") && !betterScope.type.toLowerCase().includes("module") && betterScope.upper) {
        betterScope = betterScope.upper;
    }
    return betterScope.block;
}

function findCorrespondingVariable(node, scope) {
    // return scopeManager.getDeclaredVariables(node)

    for (let ref of scope.variables.concat(scope.through)) {
        let variable = ref.resolved || ref;
        for (let id of variable.identifiers || []) {
            if (astNodeEquals(id, node)) {
                return variable;
            }
        }
        for (let ref of variable.references || []) {
            if (astNodeEquals(ref.identifier, node)) {
                return variable;
            }
        }
    }
    return null;
}

// @returns FunctionExpression|FunctionDeclaration
function findCallDefinition(node, currentScope) {
    // if (node.callee.type === Syntax.FunctionExpression) {
    //     if (node.callee.parent.type === Syntax.MethodDefinition) { // method
    //         return node.callee.parent;
    //     }
    //     return node.callee;
    // }

    // if (node.callee.type === Syntax.Identifier || node.callee.type === Syntax.MemberExpression) {
    //     let id = node.callee.type === Syntax.MemberExpression ? node.callee.property : node.callee;
    //     let variable = findCorrespondingVariable(id, currentScope);
    //     if (variable) {
    //         for (let r of variable.references) { // findReferences once again lacking...
    //             let ref = r.identifier;
    //             if (ref.parent.type === Syntax.FunctionDeclaration || ref.parent.type === Syntax.VariableDeclarator || ref.parent.type === Syntax.MethodDefinition) {
    //                 return ref.parent;
    //             }
    //         }
    //     }
    // }

    if (node.callee.type === Syntax.MemberExpression && node.callee.object.type === Syntax.ThisExpression) {
        let classBody = null;
        let predecessor = node.parent;
        while (predecessor && !classBody) {
            if (predecessor.type === Syntax.ClassBody) {
                classBody = predecessor;
                break;
            }
            predecessor = predecessor.parent;
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

    let identifier = null;
    if (node.callee.type === Syntax.Identifier) {
        identifier = node.callee;
    } else if (node.callee.type === Syntax.MemberExpression) {
        identifier = node.callee.object;
        // } else if (node.callee.type === Syntax.TaggedTemplateExpression) {
        //     id = node.callee.tag;
        // } else if (node.callee.type === Syntax.ImportSpecifier) {
        //     id = node.callee.imported;
        // } else if (node.callee.type === Syntax.ImportDefaultSpecifier) {
        //     id = node.callee.local;
        // } else if (node.callee.type === Syntax.ImportNamespaceSpecifier) {
        //     id = node.callee.local;
    } else if (node.callee.type === Syntax.FunctionExpression) {
        // identifier = node.callee.id;
        return node.callee;
    } else if (node.callee.type === Syntax.ArrowFunctionExpression) {
        // identifier = node.callee.id;
        return node.callee;
    } else if (node.callee.type === Syntax.AssignmentExpression) {
        identifier = node.callee.left;
    }
    let variable = findCorrespondingVariable(identifier, currentScope);
    if (variable && variable.defs) {
        let defs = variable.defs.filter((d) => d.type !== "Parameter");
        if (defs.length > 0) {
            if (debug && defs.length > 1) {
                console.warn("Multiple definitions for variable", variable);
            }
            let { node } = defs[0]; // TODO: Support multiple definitions
            if (node) {
                return node;
            }
        }
    }

    if (node.arguments && node.arguments.length > 0) {
        for (let arg of node.arguments) {
            if (arg.type === Syntax.FunctionExpression) {
                return arg;
            }
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

    for (let dep in deps) {
    // await Promise.all(Object.keys(deps).map(async(dep) => {
        let version = deps[dep].replace(/^\^/, ""); // TODO: https://stackoverflow.com/a/64990875/4356020
        node_modules[dep] = {
            version,
            "dependencies": await getDependencies(dep, version),
        };
        if (Object.keys(node_modules[dep].dependencies).length === 0) {
            delete node_modules[dep].dependencies;
        }
    // }));
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
        // "dagre":      resolve(__dirname, "assets", "js", "dagre.js"),
        // "cyDagre":    resolve(__dirname, "assets", "js", "cytoscape-dagre.js"),
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
    let html = await ejs.renderFile(paths.template, { title, paths, "data": data.data }, { "rmWhitespace": true });
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
    let srcContents = {};
    let libs = {};
    let calls = {};

    for (const file of srcFiles) {
        if (debug && file.includes("assets") && !file.includes("setup.js")) {
        // if (debug && !file.includes("index.js")) {
            continue;
        }
        try {
            const code = await readFile(file);
            srcContents[file] = code.toString();
            const ast = parse(code, {
                "ecmaVersion": latestEcmaVersion,
                "range":       true,
                "sourceType":  "module",
            });
            const scopeManager = analyze(ast, {
                "ecmaVersion": latestEcmaVersion,
                "sourceType":  "module",
            });
            let currentScope = scopeManager.acquire(ast);

            let libsInFile = {};
            let saveLib = async(libName, parent) => {
                libsInFile[libName] = libName.toString().toLowerCase()
                    .endsWith(".json") ? {} : discoverAPI(currentScope, parent); // API of lib (don't find API of json files?)
            };

            calls[file] = {};
            let saveCall = (source, target, node) => {
                if (!source || !target) {
                    return;
                }

                // // TODO: Support imports
                // let isLibCall = target.init && target.init.callee && target.init.callee.name === "require";

                // let parentPath = dirname(file);
                // eslint-disable-next-line no-nested-ternary
                let sourceLabel = source.type === Syntax.Program ? "(toplevel)" : (source.id ? source.id.name : (source.key ? source.key.name : "(anonymous)"));
                let sourceId = `${sourceLabel}-${source.start}-${source.end}`;
                // eslint-disable-next-line no-nested-ternary
                let targetLabel = target.id ? target.id.name || node.callee.name : (target.key ? target.key.name : "(anonymous)");
                let targetId = `${targetLabel}-${target.start}-${target.end}`;
                let edgeId = `${relative(srcPath, file)} | ${sourceId} -> ${targetId}`;

                if (debug && !sourceLabel) {
                    console.warn("sourceLabel is empty", source);
                }
                if (debug && !targetLabel) {
                    console.warn("targetLabel is empty", target);
                }

                let caller = {
                    // "type":  node.type,
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
                        "type":   source.type === Syntax.ClassDeclaration ? "Class" : "Function call",
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

            traverse(ast, {
                "leave": (node) => {
                    if (/Function/.test(node.type)) {
                        currentScope = currentScope.upper; // set to parent scope
                    }
                },
                "enter": (node, parent) => {
                    if (/Function/.test(node.type)) {
                        currentScope = scopeManager.acquire(node); // get current function scope
                    }

                    if (node.type === Syntax.ImportDeclaration) {
                        let libName = node.source.value;
                        if (debug && !libName) {
                            console.warn("Unable to determine library name from import (skipping)", node);
                            return;
                        }
                        saveLib(libName, parent);
                    } else if (node.type === Syntax.CallExpression) {
                        if (node.callee.name === "require") {
                            // 'require' only takes 1 argument: https://nodejs.org/api/modules.html#requireid
                            let argNode = node.arguments[0];
                            let libName = constructString(argNode);
                            if (debug && !libName) {
                                console.warn("Unable to determine library name from require (skipping)", node);
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
                        } else {
                            // // call -> findscope -> subroutine (source)
                            // // /    -> findref -> definition (target)
                            let source = findCallSource(node, currentScope);
                            let target = findCallDefinition(node, currentScope);
                            saveCall(source, target, node);
                        }
                    } else if (node.type === Syntax.ClassDeclaration) {
                        for (let method of node.body.body) {
                            if (method.type === Syntax.MethodDefinition) {
                                saveCall(node, method, method);
                            }
                        }
                        let source = findCallSource(node, currentScope);
                        saveCall(source, node, node);
                    }
                },
            });
            libs[file] = libsInFile;
        } catch (e) {
            console.error(`Unable to parse "${file}": ${e}`);
            console.log(e);
            continue;
        }
    }

    if (debug) {
        // console.log(JSON.stringify(calls, null, 2));
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
    // console.log({ node_modules });

    renderOutput(srcPath, {
        name,
        version,
        "data": treeData,
    });
})();
