const { findReferences } = require("./common");
const { relative } = require("path");

function findCallSource(node) {
    let betterScope = node.scope;
    while (betterScope.type && !betterScope.type.toLowerCase().includes("function") && !betterScope.type.toLowerCase().includes("module") && betterScope.upper) {
        betterScope = betterScope.upper;
    }
    return betterScope.block;
}

// @param {Object} node - CallExpression node
// @returns VariableDeclarator|FunctionExpression|FunctionDeclaration|MethodDefinition
function findCallDefinition(node) {
    if (node.callee.type === "FunctionExpression") {
        if (node.callee.parentNode.type === "MethodDefinition") { // method
            return node.callee.parentNode;
        }
        return node.callee;
    }
    if (node.callee.type === "Identifier" || node.callee.type === "MemberExpression") {
        let id = node.callee.type === "MemberExpression" ? node.callee.property : node.callee;
        for (let ref of findReferences(id)) {
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

function getCallSourceNames(source) {
    let sourceId = null;
    let sourceLabel = null;
    if (source.type === "Program") {
        sourceLabel = "(toplevel)";
        sourceId = `${sourceLabel}-${source.start}-${source.end}`;
        return { sourceId, sourceLabel };
    }
    if (source.id) {
        sourceLabel = source.id.name;
        sourceId = `${sourceLabel}-${source.start}-${source.end}`;
        return { sourceId, sourceLabel };
    }
    if (source.parentNode.id) {
        sourceLabel = source.parentNode.id.name;
        sourceId = `${sourceLabel}-${source.parentNode.start}-${source.parentNode.end}`;
        return { sourceId, sourceLabel };
    }
    if (source.key) {
        sourceLabel = source.key.name;
        sourceId = `${sourceLabel}-${source.start}-${source.end}`;
        return { sourceId, sourceLabel };
    }
    if (source.parentNode.key) {
        sourceLabel = source.parentNode.key.name;
        sourceId = `${sourceLabel}-${source.parentNode.start}-${source.parentNode.end}`;
        return { sourceId, sourceLabel };
    }
    if (source.name) {
        sourceLabel = source.name;
        sourceId = `${sourceLabel}-${source.start}-${source.end}`;
        return { sourceId, sourceLabel };
    }
    sourceLabel = "(anonymous)";
    sourceId = `${sourceLabel}-${source.start}-${source.end}`;
    return { sourceId, sourceLabel };
}

function getCallTargetNames(target) {
    let targetId = null;
    let targetLabel = null;
    if (target.id) {
        targetLabel = target.id.name;
        targetId = `${targetLabel}-${target.start}-${target.end}`;
        return { targetId, targetLabel };
    }
    if (target.key) {
        targetLabel = target.key.name;
        targetId = `${targetLabel}-${target.start}-${target.end}`;
        return { targetId, targetLabel };
    }
    targetLabel = "(anonymous)";
    targetId = `${targetLabel}-${target.start}-${target.end}`;
    return { targetId, targetLabel };
}

function extractCalls(ast, file, srcPath) {
    if (!Array.isArray(ast)) {
        throw new Error("AST must be a flattened array");
    }

    // If disabled, don't extract function calls
    if (!global.components.callGraph) {
        return {};
    }

    let calls = {};
    let saveCall = (source, target, node) => {
        if (!source || !target) {
            return;
        }

        let { sourceId, sourceLabel } = getCallSourceNames(source);
        let { targetId, targetLabel } = getCallTargetNames(target);
        let edgeId = `${relative(srcPath, file)} | ${sourceId} -> ${targetId}`;

        if (global.debug && !sourceLabel) {
            console.warn("sourceLabel is empty", source);
        }
        if (global.debug && !targetLabel) {
            console.warn("targetLabel is empty", target);
        }

        let caller = {
            "type":  node.type,
            "start": node.start,
            "end":   node.end,
        };

        // node (source)
        calls[sourceId] = {
            "data": {
                caller,
                "label":  sourceLabel,
                "color":  "#fff",
                "id":     sourceId,
                "parent": relative(srcPath, file),
                "type":   source.type === "ClassDeclaration" ? "Class" : "Function call",
            },
        };

        // node (target)
        calls[targetId] = {
            "data": {
                caller,
                "label":  targetLabel,
                "color":  "#fff",
                "id":     targetId,
                "parent": relative(srcPath, file),
                "type":   "Function call",
            },
        };

        // edge
        calls[edgeId] = {
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
        if (node.type === "CallExpression") {
            // call -> findscope -> subroutine (source)
            // /    -> findref -> definition (target)
            let source = findCallSource(node);
            let target = findCallDefinition(node);
            saveCall(source, target, node);
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

    return calls;
}

module.exports = { findCallSource, findCallDefinition, getCallSourceNames, getCallTargetNames, extractCalls };
