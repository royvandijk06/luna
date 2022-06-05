const srcPath = __dirname; // this project (small)

const { Syntax, VisitorOption, traverse } = require("estraverse");
const { parse, latestEcmaVersion } = require("espree");
const fetch = require("node-fetch");
const glob = require("glob");
const ejs = require("ejs");
const randomColor = require("randomcolor");
const { exec } = require("child_process");

const { promisify } = require("util");
const { readFile, writeFile, stat } = require("fs/promises");
const { basename, resolve, relative, dirname, extname } = require("path");

const depsCache = {};

// TODO: Fix false positives (check scopes) + false negatives (better detection)
/* Possibilities:
 * 1. Library is loaded into a single variable => variable = library name
 * 2. Library is loaded destructively into multiple objects => require(...) = library name
 * 3. After library is loaded, it gets instantiated
 */
function findReferences(ast, name) {
    const refs = [];
    const visitor = {
        enter(node) {
            if (node.type === Syntax.ImportDeclaration) {
                if (node.source.value === name) {
                    refs.push(node);
                }
            } else if (node.type === Syntax.VariableDeclarator) {
                if (node.id.type === "Identifier") {
                    if (node.id.name === name) {
                        refs.push(node);
                    }
                }
            } else if (node.type === Syntax.MemberExpression) {
                if (node.object.type === "Identifier") {
                    if (node.object.name === name) {
                        refs.push(node);
                    }
                }
            } else if (node.type === Syntax.CallExpression) {
                if (node.callee.type === "Identifier") {
                    if (node.callee.name === name) {
                        refs.push(node);
                    }
                }
            }
        },
    };
    traverse(ast, visitor, { "ecmaVersion": latestEcmaVersion, "loc": true });
    return refs;
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
        case Syntax.Literal:
            str = node.value;
            break;
        case Syntax.TemplateLiteral:
            // str = node.quasis.filter((q) => q.value.raw !== "")[0].value.raw; // wrong
            str = constructTemplateLiteral(node);
            break;
        case Syntax.Identifier:
            if (node.name === "__dirname") {
                str = srcPath;
            } else {
                str = `#${node.name}#`; // variable or function
            }
            break;
        case Syntax.BinaryExpression:
            str = `${constructString(node.left)}${constructString(node.right)}`;
            break;
        case Syntax.TemplateElement:
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
        "output":     resolve(outputPath),
    };
    let title = `${data.name || paths.output}${data.version ? `@${data.version}` : ""}`;
    let html = await ejs.renderFile(paths.template, { title, paths, data });
    return writeFile(resolve(outputPath, "./luna.html"), html);
}

(async() => {
    let getFiles = promisify(glob);
    // all javascript files in the project (excluding node_modules)
    let pattern = resolve(`${srcPath}/{,!(node_modules)/**/}*.{js,mjs}`);
    let srcFiles = (await getFiles(pattern)).map((f) => resolve(f));
    let { name, version, devDependencies, dependencies } = JSON.parse(await readFile(resolve(srcPath, "./package.json"), "utf8"));
    let hasNodeModules = await stat(resolve(srcPath, "./node_modules")).then(() => true)
        .catch(() => false);
    let node_modules = await getNodeModules(hasNodeModules, dependencies, devDependencies);
    // console.log(JSON.stringify(node_modules, null, 2));

    let externalLibs = Object.keys(dependencies).concat(Object.keys(devDependencies));
    let libs = {};

    for (const file of srcFiles) {
        try {
            const code = await readFile(file);
            const ast = parse(code, { "ecmaVersion": latestEcmaVersion, "sourceType": "module" });

            let libsInFile = {};
            let saveLib = async(libName, parent) => {
                if (!libsInFile[libName]) {
                    libsInFile[libName] = {}; // API of lib
                }
                if (parent.property) { // property of object
                    libsInFile[libName][parent.property.name] = findReferences(ast, parent.property.name);
                } else if (parent.id && parent.id.properties) { // destructuring
                    for (const prop of parent.id.properties) {
                        libsInFile[libName][prop.value.name] = findReferences(ast, prop.value.name);
                    }
                } else if (parent.id && parent.id.name) { // entire object
                    // TODO: find properties instead of saving variable name
                    // let props = findProperties(ast, parent.id.name);
                    libsInFile[libName][parent.id.name] = findReferences(ast, parent.id.name);
                } else {
                    console.log({ parent });
                }
            };
            traverse(ast, {
                "enter": (node, parent) => {
                    if (node.type === Syntax.ImportDeclaration) {
                        let libName = node.source.value;
                        if (!libName) {
                            console.error("Unable to determine library name 1 (skipping)", node, JSON.stringify(node, null, 2));
                            return VisitorOption.Continue;
                        }
                        saveLib(libName, parent);
                        return VisitorOption.Skip;
                    } else if (node.type === Syntax.CallExpression) {
                        if (node.callee.name === "require") {
                            // require only takes 1 argument: https://nodejs.org/api/modules.html#requireid
                            let argNode = node.arguments[0];
                            let libName = constructString(argNode);
                            if (!libName) {
                                console.error("Unable to determine library name 2 (skipping)", node, JSON.stringify(node, null, 2));
                                return VisitorOption.Continue;
                            }
                            saveLib(libName, parent);
                            return VisitorOption.Skip;
                        }
                    }
                    return VisitorOption.Continue;
                },
            });
            libs[file] = libsInFile;
        } catch (e) {
            console.error(`Unable to parse "${file}": ${e}`);
            continue;
        }
    }

    // GROUPS
    let treeData = [
        { "data": { "label": "Files", "color": "#fff", "id": "files" } },
        { "data": { "label": "Libraries", "color": "#fff", "id": "libs" } },
        { "data": { "label": "Unused", "color": "#fff", "parent": "libs", "id": "unused" } },
        { "data": { "label": "Internal", "color": "#fff", "parent": "libs", "id": "internal" } },
        { "data": { "label": "External", "color": "#fff", "parent": "libs", "id": "external" } },
        { "data": { "label": "Dependency Tree", "color": "#fff", "id": "deps" } },
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
                // console.log({ file, srcPath, lib, internalPath, altInternalPath, srcFile, ext, isInternalDep, srcFiles });
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
                        "isData":  libName.toLocaleLowerCase().endsWith(".json"),
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

            // node
            filesTreeData[fileId].push({
                "data": {
                    id,
                    "library": libName,
                    "color":   "#999",
                    "parent":  externalLibs.includes(libName) ? "external" : "internal", // group: external or internal
                    "label":   id,
                },
            });

            for (let varname in libs[file][libName]) {
                // for (let node of libs[file][lib][varname]) {
                let apiCall = varname;
                // node
                filesTreeData[fileId].push({
                    "data": {
                        "id":    varname,
                        "color": "#999",
                        "label": varname,
                    },
                });
                // edge
                filesTreeData[fileId].push({
                    "data": {
                        "id":     `${id} -> ${varname}`,
                        "color":  "#999",
                        "source": id,
                        "target": varname,
                    },
                });
                // }
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
