/**
 * It returns all references to a node, except for the node itself
 * @param {Node} node - The node to find references for.
 * @returns {Node[]} An array of references to the node.
 */
function findReferences(node) {
    if (!node) {
        if (global.debug) { console.log(new Error("No node")); }
        return [];
    }

    // let references = [].concat(node.references || [], node.declNode ? [node.declNode] : []);
    let references = node.declNode ? node.declNode.references.concat([node.declNode]) : node.references || [];
    let refIds = [node.nodeId];
    return references.filter((n) => {
        let res = !refIds.includes(n.nodeId);
        refIds.push(n.nodeId);
        return res;
    });
}

/**
 * It takes a TemplateLiteral node and the path to the project's root directory, and returns a string that is the concatenation
 * of the strings in the template literal
 * @param {TemplateLiteral} node - The node that we're currently constructing a string for.
 * @param {string} srcPath - The path to the project's root directory, needed for constructString().
 * @returns {string} A string that is the concatenation of the strings in the template literal.
 */
function constructTemplateLiteral(node, srcPath) {
    let str = "";
    let nodes = [...node.quasis, ...node.expressions].sort((a, b) => a.start - b.start);
    for (let i = 0; i < nodes.length; i++) {
        let node = nodes[i];
        // eslint-disable-next-line no-use-before-define
        str += constructString(node, srcPath);
    }
    return str;
}

/**
 * It takes a node and a source path, and returns a string
 * @param {Node} node - The AST node that we're currently processing.
 * @param {string} srcPath - The path to the project's root directory.
 * @returns The string value of the node.
 */
function constructString(node, srcPath) {
    let str = "";

    switch (node.type) {
        case "Literal":
            str = node.value;
            break;
        case "TemplateLiteral":
            str = constructTemplateLiteral(node, srcPath);
            break;
        case "Identifier":
            if (node.name === "__dirname" && srcPath) {
                str = srcPath;
            } else {
                str = `#${node.name}#`; // variable or function
            }
            break;
        case "BinaryExpression":
            str = `${constructString(node.left, srcPath)}${constructString(node.right, srcPath)}`;
            break;
        case "TemplateElement":
            str = node.value.raw;
            break;
        default:
            break;
    }

    return str;
}

module.exports = { findReferences, constructString, constructTemplateLiteral };
