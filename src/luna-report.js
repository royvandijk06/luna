const { resolve } = require("path");
const { writeFile } = require("fs/promises");
const pkg = require("../package.json");
const ejs = require("ejs");

/**
 * Renders the template with the data, and writes the result to the output path.
 * @param {string} outputPath - The path to the output directory.
 * @param {{name: string, version: string, data}} data - The data object that was passed to the render function.
 * @returns {Promise<string>} The path to the generated HTML file.
 */
async function renderOutput(outputPath, data) {
    let paths = {
        "cy":            resolve(__dirname, "..", "assets", "js", "cytoscape.min.js"),
        "cyCollapse":    resolve(__dirname, "..", "assets", "js", "cytoscape-expand-collapse.js"),
        "elk":           resolve(__dirname, "..", "assets", "js", "elk.bundled.js"),
        "cyElk":         resolve(__dirname, "..", "assets", "js", "cytoscape-elk.js"),
        "cola":          resolve(__dirname, "..", "assets", "js", "cola.min.js"),
        "cyCola":        resolve(__dirname, "..", "assets", "js", "cytoscape-cola.js"),
        "shim":          resolve(__dirname, "..", "assets", "js", "shim.min.js"),
        "layoutBase":    resolve(__dirname, "..", "assets", "js", "layout-base.js"),
        "coseBase":      resolve(__dirname, "..", "assets", "js", "cose-base.js"),
        "cyCoseBilkent": resolve(__dirname, "..", "assets", "js", "cytoscape-cose-bilkent.js"),
        "cySetup":       resolve(__dirname, "..", "assets", "js", "cytoscape-setup.js"),
        "stylesheet":    resolve(__dirname, "..", "assets", "css", "stylesheet.css"),
        "fontawesome":   resolve(__dirname, "..", "assets", "css", "fontawesome.min.css"),
        "regularFont":   resolve(__dirname, "..", "assets", "css", "regular.min.css"),
        "solidFont":     resolve(__dirname, "..", "assets", "css", "solid.min.css"),
        "template":      resolve(__dirname, "..", "assets", "html", "template.ejs"),
        "output":        resolve(outputPath),
    };
    let title = `${data.name || paths.output}${data.version ? `@${data.version}` : ""}`;
    let html = await ejs.renderFile(paths.template, { "debug": global.debug, title, paths, "data": data.data, "version": pkg.version }, { "rmWhitespace": true });
    let result = resolve(outputPath, "luna.html");
    return writeFile(result, html).then(() => result);
}

/**
 * A wrapper function for renderOutput().
 * @param {string} srcPath - The path to the project's root directory.
 * @param {string} name - The name of the project.
 * @param {string} version - The version of the project.
 * @param {Object} data - The data that will be used to generate the output.
 * @returns {Promise<string>} The output of the renderOutput() function.
 */
async function generate(srcPath, name, version, data) {
    let output = await renderOutput(srcPath, {
        name,
        version,
        data,
    });

    return output;
}

module.exports = { generate, renderOutput };
