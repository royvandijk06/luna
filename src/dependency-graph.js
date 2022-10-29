const { exec } = require("child_process");
const { promisify } = require("util");
const fetch = require("node-fetch");

const depsCache = {};

/**
 * It fetches the dependencies of a given package and version, and returns them, along with the tags (if available).
 * @param {string} name - The name of the package.
 * @param {string} version - The version of the package to fetch.
 * @returns {Promise<{dependencies: Object, tags: string[]}>} The dependencies (and tags) of the given package.
 * @throws {Error} If the package is not found.
 */
async function getDependencies(name, version) {
    let pkg = `${name}@${version}`;
    if (depsCache[pkg]) {
        return depsCache[pkg];
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
    let { dependencies, keywords } = await response.json();
    // eslint-disable-next-line no-use-before-define
    let parsedDependencies = await parseDependencies(dependencies);
    depsCache[pkg] = {
        "dependencies": parsedDependencies,
        "tags":         keywords || [],
    };
    return depsCache[pkg];
}

/**
 * It takes in the dependencies and devDependencies from the package.json file, and returns an object
 * with the dependencies and their versions, and the tags for each dependency
 * @param {Object} dependencies - The dependencies object from the package.json file.
 * @param {Object} [devDependencies] - The devDependencies object from the package.json file.
 * @returns {Promise<Object>} An object with the dependencies.
 */
async function parseDependencies(dependencies, devDependencies = {}) {
    let node_modules = {};
    let deps = { ...dependencies, ...devDependencies };

    for (let dep in deps) {
        let version = deps[dep].replace(/^\^/, ""); // TODO: https://stackoverflow.com/a/64990875/4356020
        let { dependencies, tags } = await getDependencies(dep, version);
        node_modules[dep] = {
            version,
            dependencies,
            tags,
        };
        if (Object.keys(node_modules[dep].dependencies).length === 0) {
            delete node_modules[dep].dependencies;
        }
    }

    return node_modules;
}

/**
 * It gets the dependencies from the package.json file, or if the user has specified to use local
 * dependencies, it gets the dependencies from the node_modules folder
 * @param {string} srcPath - The path to the project's root directory
 * @param {boolean} useLocalDependencies - If true, the function will use the local dependencies in the srcPath
 * directory. If false, it will fetch the dependencies from the package.json file.
 * @param {Object} dependencies - The dependencies object from the package.json file.
 * @param {Object} devDependencies - The devDependencies object from the package.json file.
 * @returns {Promise<Object>} A promise that resolves to an object containing the dependencies of the project.
 * @throws {Error} If parsing local dependencies fails.
 */
async function getNodeModules(srcPath, useLocalDependencies, dependencies, devDependencies) {
    if (!global.components.dependencyTree || (!useLocalDependencies && !dependencies)) {
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

module.exports = { getDependencies, parseDependencies, getNodeModules };
