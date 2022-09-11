const { resolve } = require("path");
const { writeFile } = require("fs/promises");
const pkg = require("../package.json");
const ejs = require("ejs");

async function renderOutput(outputPath, data) {
    let paths = {
        "cy":            resolve(".", "assets", "js", "cytoscape.min.js"),
        "cyCollapse":    resolve(".", "assets", "js", "cytoscape-expand-collapse.js"),
        "elk":           resolve(".", "assets", "js", "elk.bundled.js"),
        "cyElk":         resolve(".", "assets", "js", "cytoscape-elk.js"),
        "cola":          resolve(".", "assets", "js", "cola.min.js"),
        "cyCola":        resolve(".", "assets", "js", "cytoscape-cola.js"),
        "shim":          resolve(".", "assets", "js", "shim.min.js"),
        "layoutBase":    resolve(".", "assets", "js", "layout-base.js"),
        "coseBase":      resolve(".", "assets", "js", "cose-base.js"),
        "cyCoseBilkent": resolve(".", "assets", "js", "cytoscape-cose-bilkent.js"),
        "cySetup":       resolve(".", "assets", "js", "cytoscape-setup.js"),
        "stylesheet":    resolve(".", "assets", "css", "stylesheet.css"),
        "fontawesome":   resolve(".", "assets", "css", "fontawesome.min.css"),
        "regularFont":   resolve(".", "assets", "css", "regular.min.css"),
        "solidFont":     resolve(".", "assets", "css", "solid.min.css"),
        "template":      resolve(".", "assets", "html", "template.ejs"),
        "output":        resolve(outputPath),
    };
    let title = `${data.name || paths.output}${data.version ? `@${data.version}` : ""}`;
    let html = await ejs.renderFile(paths.template, { "debug": global.debug, title, paths, "data": data.data, "version": pkg.version }, { "rmWhitespace": true });
    let result = resolve(outputPath, "./luna.html");
    return writeFile(result, html).then(() => result);
}

async function generate(srcPath, name, version, data) {
    let output = await renderOutput(srcPath, {
        name,
        version,
        data,
    });

    return output;
}

module.exports = { generate, renderOutput };
