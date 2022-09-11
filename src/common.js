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
