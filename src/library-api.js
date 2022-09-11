const { dirname, resolve } = require("path");
const { findCallSource, getCallSourceNames } = require("./call-graph");
const { findReferences, constructString } = require("./common");

/* Possibilities:
 * 1. Library is loaded into a single variable => variable = library name
 * 2. Library is loaded destructively into multiple objects => require(...) = library name
 * 3. After library is loaded, it gets instantiated
 */
function discoverAPI(parent, _api = {}) {
    let api = _api;

    let addToAPI = (name, node) => {
        let source = findCallSource(node);
        let { sourceId } = getCallSourceNames(source);
        api[name] = api[name] || {};
        api[name].name = name;
        api[name].sourceIds = (api[name].sourceIds || []).concat(sourceId);
        api[name].nodes = (api[name].nodes || []).concat([node]);
        for (let ref of findReferences(node)) {
            let source = findCallSource(ref);
            let { sourceId } = getCallSourceNames(source);
            api[name].sourceIds = (api[name].sourceIds || []).concat(sourceId);
            api[name].children = discoverAPI(ref.parentNode, api[name].children);
        }
    };

    if (parent.property && parent.computed === false) { // property of object
        addToAPI(parent.property.name, parent.property);
    } else if (parent.id && parent.id.properties) { // destructuring
        let props = parent.id.properties;
        for (const prop of props) {
            addToAPI(prop.value?.name || prop.key.name, prop.value || prop.key); // choose value over key if it exists
            // addToAPI((prop.value && prop.value.name) || prop.key.name, prop.value || prop.key); // choose value over key if it exists
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
            // api = discoverAPI(ref.parentNode, api);
        }
    } else if (parent.type === "NewExpression") { // new instance of library
        if (parent.parentNode.id) { // instance assigned to a variable
            addToAPI("(instance)", parent.parentNode.id);
        } else if (parent.parentNode.left && parent.parentNode.left.property && !parent.parentNode.left.computed) { // instance assigned to a property
            addToAPI("(instance)", parent.parentNode.left.property);
        }
    } else if (global.debug) {
        console.warn("Could not find API for", parent);
    }
    return api;
}

function extractLibs(ast, file, srcPath) {
    if (!Array.isArray(ast)) {
        throw new Error("AST must be a flattened array");
    }

    // If disabled, don't extract library api
    if (!global.components.libraryAPI) {
        return {};
    }

    let libs = {};
    let saveLib = (libName, parent) => {
        libs[libName] = libName.toString().toLowerCase()
            .endsWith(".json") ? {} : discoverAPI(parent); // API of lib (don't find API of json files)
    };

    for (let node of ast) {
        let parent = node.parentNode;
        // TODO: Support amdefine?

        // imports from other libraries
        if (node.type === "ImportDeclaration") {
            let libName = node.source.value;
            if (!libName) {
                if (global.debug) {
                    console.warn("Unable to determine library name from import (skipping)", node);
                }
                continue;
            }
            saveLib(libName, parent);
        } else if (node.type === "CallExpression" && node.callee.name === "require") {
            // 'require' only takes 1 argument: https://nodejs.org/api/modules.html#requireid
            let argNode = node.arguments[0];
            let libName = constructString(argNode, srcPath);
            if (!libName) {
                if (global.debug) {
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

        // TODO: exports from this file
    }
    return libs;
}

module.exports = { discoverAPI, extractLibs };
