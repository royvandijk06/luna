#!/usr/bin/env node

const { createInterface } = require("readline");
const { exec } = require("child_process");
const { generate } = require("./luna-report");
const { resolve } = require("path");
const { scan } = require("./scanner");

const rl = createInterface({
    "input":  process.stdin,
    "output": process.stdout,
});

const srcPath = process.argv[2] || process.cwd();
if (!srcPath) {
    throw new Error("No project path specified");
}

let pkg = {};
try {
    pkg = require(resolve(srcPath, "./package.json"));
} catch (unused) {
    // ignore
}

const defaults = {
    "debug":      false,
    "components": {
        "callGraph":      true,
        "dependencyTree": true,
        "libraryAPI":     true,
    },
    "ignore": [],
};

const { name, version, devDependencies, dependencies, main, luna } = pkg;
const config = luna || {};
global.debug = process.argv[3] === "1" || process.argv[3] === "true" ? true : config.debug || defaults.debug;
global.components = { ...defaults.components, ...config.components };
global.ignore = config.ignore || defaults.ignore;

console.log(`LUNA is scanning ${srcPath}...`);
scan(srcPath, dependencies, devDependencies, main)
    .then((data) => generate(srcPath, name, version, data))
    .then((output) => {
        console.log(`LUNA report successfully generated in ${output}`);
        rl.question("Do you want to open the report? (y/n) ", (answer) => {
            let cmd = "xdg-open";
            switch (process.platform) {
                case "darwin":
                    cmd = "open";
                    break;
                case "win32":
                case "win64":
                    cmd = "start";
                    break;
            }
            if (answer === "y") {
                exec(`${cmd} ${output}`);
            }
            rl.close();
        });
    })
    .catch((err) => {
        console.error("LUNA has crashed", err);
        rl.close();
    });
