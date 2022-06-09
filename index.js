const srcPath = __dirname; // this project (small)

const astWalk = require("acorn-walk").fullAncestor;
const AST = require("acorn-loose");
const fetch = require("node-fetch");
const glob = require("glob");
const ejs = require("ejs");
const randomColor = require("randomcolor");
const scan = require("scope-analyzer");
const { exec } = require("child_process");

const { promisify } = require("util");
const { readFile, writeFile, stat } = require("fs/promises");
const { basename, resolve, relative, dirname, extname } = require("path");

const depsCache = {};

function findReferences(node) {
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
function findAPI(ast, parent, _api = {}) {
    let api = _api;
    let addToAPI = (name, node) => {
        api[name] = api[name] || {};
        api[name].name = name;
        api[name].nodes = (api[name].nodes || []).concat([node]);
        for (let ref of findReferences(node)) {
            api[name].children = findAPI(ast, ref.parent, api[name].children);
        }
    };

    if (parent.property) { // property of object
        addToAPI(parent.property.name, parent.property);
    } else if (parent.id && parent.id.properties) { // destructuring
        let props = parent.id.properties;
        for (const prop of props) {
            addToAPI(prop.value?.name || prop.key.name, prop.value || prop.key); // choose value over key if it exists
            if (prop.value && prop.value.properties) {
                // TODO: support nested destructuring
            }
        }
    } else if (parent.id) { // variable name
        for (let ref of findReferences(parent.id)) {
            api = findAPI(ast, ref.parent, api);
        }
    } else if (parent.type === "NewExpression") { // new instance of library
        addToAPI("{{instance}}", parent.parent.id);
    } else {
        console.log("CANNOT FIND API", { parent });
    }
    return api;
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
    let deps = { ...dependencies, ...devDependencies };

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
        throw new Error("No dependencies found");
    }

    if (useLocalDependencies) {
        let execute = promisify(exec);

        let { stdout, stderr } = await execute("npm ls --all --json", { "cwd": srcPath });
        if (stderr) {
            throw new Error(stderr);
        }

        return JSON.parse(stdout);
    }

    return parseDependencies(dependencies, devDependencies);
}

function constructTemplateLiteral(node) {
    let str = "";
    let nodes = [...node.quasis, ...node.expressions].sort((a, b) => a.start - b.start);
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
            // str = node.quasis.filter((q) => q.value.raw !== "")[0].value.raw; // wrong
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
    let html = await ejs.renderFile(paths.template, { title, paths, data });
    return writeFile(resolve(outputPath, "./luna.html"), html);
}

(async() => {
    let getFiles = promisify(glob);
    // all javascript files in the project (excluding node_modules)
    let pattern = resolve(`${srcPath}/{,!(node_modules)/**/}*.{js,mjs}`).replace(/\\/g, "/");
    let srcFiles = (await getFiles(pattern)).map((f) => resolve(f));
    let { name, version, devDependencies, dependencies } = JSON.parse(await readFile(resolve(srcPath, "./package.json"), "utf8"));
    let hasNodeModules = await stat(resolve(srcPath, "./node_modules")).then(() => true)
        .catch(() => false);
    let node_modules = await getNodeModules(hasNodeModules, dependencies, devDependencies);
    let externalLibs = Object.keys(dependencies).concat(Object.keys(devDependencies));
    let libs = {};

    for (const file of srcFiles) {
        try {
            const code = await readFile(file);
            const ast = AST.parse(code, { "ecmaVersion": "latest", "sourceType": "module" });

            scan.createScope(ast, ["module", "require", "exports", "__dirname", "__filename"]);
            scan.crawl(ast);

            let libsInFile = {};
            let saveLib = async(libName, parent) => {
                libsInFile[libName] = libName.toLocaleLowerCase().endsWith(".json") ? {} : findAPI(ast, parent); // API of lib (don't find API of json files)
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
                    if (node.callee.name === "require") {
                        // 'require' only takes 1 argument: https://nodejs.org/api/modules.html#requireid
                        let argNode = node.arguments[0];
                        let libName = constructString(argNode);
                        if (!libName) {
                            console.error("Unable to determine library name 2 (skipping)", node, JSON.stringify(node, null, 2));
                            return;
                        }
                        saveLib(libName, parent);
                    }
                }
            });
            libs[file] = libsInFile;
        } catch (e) {
            console.error(`Unable to parse "${file}": ${e}`);
            continue;
        }
    }

    // GROUPS
    let treeData = [
        { "data": { "label": "Files", "color": "#fff", "id": "files", "group": true } },
        { "data": { "label": "Libraries", "color": "#fff", "id": "libs", "group": true } },
        { "data": { "label": "Unused", "color": "#fff", "parent": "libs", "id": "unused", "group": true } },
        { "data": { "label": "Internal", "color": "#fff", "parent": "libs", "id": "internal", "group": true } },
        { "data": { "label": "External", "color": "#fff", "parent": "libs", "id": "external", "group": true } },
        { "data": { "label": "Dependency Tree", "color": "#fff", "id": "deps", "group": true } },
    ];
    let filesTreeData = {};

    // COLORS
    let libSet = [
        ...new Set(Object.values(libs).map((lib) => Object.keys(lib))
            .flat()
            .concat(Object.keys(node_modules))),
    ];
    console.log({ libSet });
    let nLibs = libSet.length; // number of libraries?
    let randomColors = randomColor({
        "count":      nLibs,
        "luminosity": "bright",
    });
    let colors = {};

    // FILES & LIBRARIES
    for (let file in libs) {
        let isRootFile = relative(srcPath, dirname(file)) === "";
        let fileId = relative(srcPath, file);
        let fileName = basename(file);
        let fileExt = extname(file);
        let parentFolder = basename(dirname(file));
        let parentParentFolder = basename(dirname(dirname(file)));
        let isParentRoot = relative(srcPath, dirname(dirname(file))) === "";

        if (!isRootFile) {
            // group
            treeData.push({
                "data": {
                    "label":  `/${parentFolder}`,
                    "group":  true,
                    "color":  "#fff",
                    "parent": isParentRoot ? "files" : parentParentFolder,
                    "id":     parentFolder,
                },
            });
        }

        // node
        treeData.push({
            "data": {
                "id":     fileId,
                "isData": fileExt === ".json",
                "color":  "#999",
                "path":   file,
                "parent": isRootFile ? "files" : parentFolder,
                "label":  fileName,
            },
        });

        filesTreeData[fileId] = [];

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
                    },
                });
            }

            // edge
            treeData.push({
                "data": {
                    "id":     `${fileId} -> ${id}`,
                    "color":  "#999",
                    "source": fileId,
                    "target": id,
                },
            });

            let recurseApi = (api, source, parent) => {
                for (let name in api) {
                    if (!name || !source || name === "undefined" || source === "undefined") { console.log(api.undefined); }
                    // node
                    filesTreeData[fileId].push({
                        "data": {
                            // parent,
                            "id":    `${parent} | ${source}`,
                            "color": "#999",
                            "label": source,
                        },
                    });
                    // node
                    filesTreeData[fileId].push({
                        "data": {
                            // parent,
                            "id":    `${parent} | ${name}`,
                            "color": "#999",
                            "label": name,
                        },
                    });
                    // edge
                    filesTreeData[fileId].push({
                        "data": {
                            // parent,
                            "id":     `${parent} | ${source} -> ${name}`,
                            "color":  "#999",
                            "source": `${parent} | ${source}`,
                            "target": `${parent} | ${name}`,
                        },
                    });
                    recurseApi(api[name].children, name, parent);
                }
            };
            recurseApi(libs[file][libName], libName, libName);
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

    renderOutput(srcPath, {
        name,
        version,
        "main":  treeData,
        "files": filesTreeData,
    });
})();
