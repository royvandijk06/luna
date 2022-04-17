const srcPath = "C:\\Users\\Roy\\OneDrive\\Projects\\NodeJS\\src-lib-scanner"; // this project

const { Syntax, VisitorOption, traverse } = require("estraverse");
const { parse, latestEcmaVersion } = require("espree");
const glob = require("glob");
const { promisify } = require("util");
const { readFile } = require("fs/promises");
const { resolve } = require("path");

// TODO: Fix false positives (check scopes) + false negatives (better detection)
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

(async() => {
    let getFiles = promisify(glob);
    let srcFiles = (await Promise.all([
        getFiles(resolve(srcPath, "./**/*.js")),
        getFiles(resolve(srcPath, "./**/*.mjs")),
    ])).flat();
    let { dependencies } = JSON.parse(await readFile(resolve(srcPath, "./package.json"), "utf8"));
    let globalLibs = Object.keys(dependencies);
    let libs = {};

    for (const file of srcFiles) {
        try {
            const code = await readFile(file);
            const ast = parse(code, { "ecmaVersion": latestEcmaVersion });

            let libsInFile = {};
            let saveLib = (libName, parent) => {
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
                        saveLib(libName, parent);
                        return VisitorOption.Skip;
                    } else if (node.type === Syntax.CallExpression) {
                        if (node.callee.name === "require") {
                            let libName = node.arguments[0].value;
                            if (!libName && node.arguments[0].quasi) {
                                libName = node.arguments[0].quasi.name;
                            } else if (!libName && node.arguments[0].quasis) {
                                libName = node.arguments[0].quasis[0].value.raw;
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
})();
