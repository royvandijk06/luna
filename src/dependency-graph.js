const { exec } = require("child_process");
const { promisify } = require("util");
const fetch = require("node-fetch");

const depsCache = {};

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
    let { dependencies, keywords } = await response.json();
    // eslint-disable-next-line no-use-before-define
    let parsedDependencies = await parseDependencies(dependencies);
    depsCache[`${name}@${version}`] = {
        "dependencies": parsedDependencies,
        "tags":         keywords || [],
    };
    return depsCache[`${name}@${version}`];
}

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
