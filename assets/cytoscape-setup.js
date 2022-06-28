/* eslint-env browser */
/* global cytoscape  */

let isLocked = false;
let isHighlighted = false;
let cyDataEnabled = true;
let cyDataNodes = null;
let cyDataEdges = null;

function fade(element) {
    let op = 1; // initial opacity
    const timer = setInterval(() => {
        if (op <= 0.1) {
            clearInterval(timer);
            element.style.display = "none";
        }
        element.style.opacity = op;
        element.style.filter = `alpha(opacity=${op * 100})`;
        op -= op * 0.1;
    }, 50);
}

// eslint-disable-next-line no-unused-vars
function unfade(element) {
    let op = 0.1; // initial opacity
    element.style.display = "block";
    const timer = setInterval(() => {
        if (op >= 1) {
            clearInterval(timer);
        }
        element.style.opacity = op;
        element.style.filter = `alpha(opacity=${op * 100})`;
        op += op * 0.1;
    }, 10);
}

function setInfoPanel({ id, type, library, path, isData, label, parent }) {
    let infoPanel = document.querySelector("#info");
    infoPanel.style.display = "block";
    infoPanel.dataset.nodeId = id;
    let infoContent = infoPanel.querySelector("#info-content");
    let html = `<table><tr><td><b>Label:</b></td><td>${label}</td></tr>`;
    if (!type) {
        type = "unknown";
        if (isData) {
            type = "data";
        } else if (library) {
            type = "library";
        } else if (path) {
            type = "source code";
        }
    }
    html += `<tr><td><b>Type:</b></td><td>${type}</td></tr>`;
    if (library) {
        html += `<tr><td><b>Library:</b></td><td>${library.name}</td></tr>`;
        if (library.version) {
            html += `<tr><td><b>Version:</b></td><td>${library.version}</td></tr>`;
        }
        if (parent === "external" || parent === "deps") {
            let isValidVersion = /^[a-z0-9.]+$/i.test(library.version); // good version validation?
            html += `<tr><td><b>NPM:</b></td><td><a href="https://www.npmjs.com/package/${library.name}${isValidVersion ? `/v/${library.version}` : ""}" target="_blank">${library.name} &#128279;&#xFE0E;</a></td></tr>`;
        }
    }
    if (path) {
        html += `<tr><td><b>Path:</b></td><td>${path}</td></tr>`;
    }
    html += "</table><br>";
    infoContent.innerHTML = html;
}

function highlightNode(node) {
    if (isHighlighted) {
        window.cy.$("node[^group], edge").style({ "opacity": 1 });
        isHighlighted = false;
        document.querySelector("#highlightBtn").innerHTML = "Highlight";
    } else {
        window.cy.$("node[^group], edge").style({ "opacity": 0.1 });
        node.style({ "opacity": 1 });
        node.predecessors().style({ "opacity": 1 });
        node.successors().style({ "opacity": 1 });
        isHighlighted = true;
        document.querySelector("#highlightBtn").innerHTML = "Undo";
    }
}

function makeCy(style, layout) {
    window.cy = cytoscape({
        "container":           document.querySelector("#cy"),
        "elements":            window.data.main,
        style,
        layout,
        "wheelSensitivity":    0.1,
        "headless":            false,
        "boxSelectionEnabled": false,
    });

    window.cy.ready(() => {
        fade(document.querySelector("#loader"));
        cyDataNodes = window.cy.$("node[id $= '.json']");
        cyDataEdges = cyDataNodes.connectedEdges();

        window.cy.expandCollapse({
            "layoutBy": layout,

            "fisheye":           false,
            "animate":           true,
            "animationDuration": 1500,
            "undoable":          false,

            "cueEnabled":                     true,
            "expandCollapseCuePosition":      "top-left",
            "expandCollapseCueSize":          12,
            "expandCollapseCueLineSize":      8,
            "expandCueImage":                 undefined,
            "collapseCueImage":               undefined,
            "expandCollapseCueSensitivity":   1,
            "edgeTypeInfo":                   "edgeType",
            "groupEdgesOfSameTypeOnCollapse": false,
            "allowNestedEdgeCollapse":        true,
            "zIndex":                         999, // z-index value of the canvas in which cue ımages are drawn
        });
        let api = window.cy.expandCollapse("get");
        window.cy.nodes().on("expandcollapse.aftercollapse", (evt) => {
            evt.target.data("collapsed", false);
            api.collapseAllEdges();
        });
        window.cy.nodes().on("expandcollapse.afterexpand", (evt) => {
            evt.target.data("collapsed", true);
            api.collapseAllEdges();
            // redo highlighting (if enabled)
            if (isHighlighted) {
                isHighlighted = false;
                document.querySelector("#highlightBtn").click();
            }
            // document.querySelector("#centerBtn").click();
        });
        api.collapse(window.cy.elements("#deps, node[group][library]"));
    });

    window.cy.nodes().on("click", () => {
        document.querySelector("#lockBtn").click();
        // let clickedNode = e.target;
        // let id = clickedNode.data("id");
        // let library = clickedNode.data("library");

        // if (clickedNode.data("parent") === "external" || clickedNode.data("parent") === "deps") {
        //     let isValidVersion = /^[a-z0-9.]+$/i.test(library.version); // good version validation?
        //     window.open(`https://www.npmjs.com/package/${library.name}${isValidVersion ? `/v/${library.version}` : ""}`, "_blank");
        //     return;
        // }

        // if (!window.data.files[id]) {
        //     return;
        // }

        // window.cy = cytoscape({
        //     "container":           document.querySelector("#cy"),
        //     "elements":            window.data.files[id],
        //     style,
        //     layout,
        //     "wheelSensitivity":    0.1,
        //     "headless":            false,
        //     "boxSelectionEnabled": false,
        // });

        // document.querySelector("#info").style.display = "none";
        // document.querySelector("#bShowData").style.display = "none";
        // document.querySelector("[for=bShowData]").style.display = "none";
    });

    window.cy.on("mouseover", "node[^group], node[library]", (evt) => {
        if (isLocked) {
            return;
        }
        let node = evt.target;
        setInfoPanel(node.data());
        isHighlighted = false;
        highlightNode(node);
    });

    window.cy.on("mouseout", "node", (evt) => {
        if (isLocked) {
            return;
        }
        let node = evt.target;
        isHighlighted = true;
        highlightNode(node);
    });
}

function pageReady() {
    const settingsPanel = { // settings
        "bShowData": document.querySelector("#bShowData"), // show data (.json files)
        "fitBtn":    document.querySelector("#fitBtn"), // reset cytoscape
        "resetBtn":  document.querySelector("#resetBtn"), // fit cytoscape
        "imgBtn":    document.querySelector("#imgBtn"), // save img cytoscape
        // "backBtn":   document.querySelector("#backBtn"), // back cytoscape
    };
    const infoPanel = { // info
        "centerBtn":    document.querySelector("#centerBtn"), // center node
        "highlightBtn": document.querySelector("#highlightBtn"), // highlight node
        "lockBtn":      document.querySelector("#lockBtn"), // highlight node
    };
    cyDataEnabled = settingsPanel.bShowData.checked;

    const layout = {
        "name":              "dagre",
        "rankDir":           "LR",
        // "rankDir":           "TB",
        // "align":   "UR",
        // "ranker":  "longest-path",
        // "ranker":  "tight-tree",
        // "ranker":  "network-simplex",
        "nodeSep":           0, // the separation between adjacent nodes in the same rank
        // "edgeSep": 10, // the separation between adjacent edges in the same rank
        // "rankSep": 100, // the separation between each rank in the layout
        "fit":               true, // whether to fit to viewport
        "padding":           10, // fit padding
        "animate":           true,
        "animationDuration": 1500,

        // "name":                        "breadthfirst",
        // "fit":                         true, // whether to fit the viewport to the graph
        // "directed":                    true, // whether the tree is directed downwards (or edges can point in any direction if false)
        // "padding":                     0, // padding on fit
        // "circle":                      false, // put depths in concentric circles if true, put depths top down if false
        // "grid":                        false, // whether to create an even grid into which the DAG is placed (circle:false only)
        // "spacingFactor":               1, // positive spacing factor, larger => more space between nodes (N.B. n/a if causes overlap)
        // "boundingBox":                 undefined, // constrain layout bounds; { x1, y1, x2, y2 } or { x1, y1, w, h }
        "avoidOverlap":                true, // prevents node overlap, may overflow boundingBox if not enough space
        "nodeDimensionsIncludeLabels": true, // Excludes the label when calculating node bounding boxes for the layout algorithm
        // "roots":                       undefined, // the roots of the trees
        // "maximal":                     true, // whether to shift nodes down their natural BFS depths in order to avoid upwards edges (DAGS only)
        // "depthSort":                   undefined, // a sorting function to order nodes at equal depth. e.g. function(a, b){ return a.data('weight') - b.data('weight') }
        // "animate":                     false, // whether to transition the node positions
        // "animationDuration":           500, // duration of animation in ms if enabled
    };

    const style = [
        {
            "selector": "node",
            "style":    {
                // "width":                   50,
                // "height":                  50,
                "background-color":           "data(color)",
                "label":                      "data(label)",
                "color":                      "data(color)",
                "text-valign":                "center",
                "text-halign":                "center",
                "background-opacity":         1,
                "text-background-opacity":    0.5,
                "text-background-color":      "#000",
                "text-background-padding":    3,
                "text-wrap":                  "wrap",
                "text-overflow-wrap":         "anywhere",
                // "text-max-width":             80,
                // "text-rotation":           "10deg",
                "compound-sizing-wrt-labels": "include",
            },
        },
        {
            "selector": ":parent, node[?group][^library]",
            "css":      {
                "background-color":   "data(color)",
                "background-opacity": 0.1,
                "text-valign":        "top",
                "text-halign":        "center",
                "text-transform":     "uppercase",
                "text-margin-y":      -5,
                "text-max-width":     200,

            },
        },
        {
            "selector": "edge",
            "style":    {
                "width":              3,
                "line-color":         "data(color)",
                "target-arrow-color": "data(color)",
                "target-arrow-shape": "triangle",
                "arrow-scale":        2,
                "curve-style":        "bezier",
            },
        },
        {
            "selector": "node[?isMain]",
            "style":    {
                "width":            50,
                "height":           50,
                "background-color": "black",
                "border-color":     "white",
                "border-width":     5,

            },
        },
        // {
        //     "selector": "node[?group][^collapsed]:childless",
        //     "style":    { "display": "none" },
        // },
    ];

    settingsPanel.bShowData.addEventListener("input", () => {
        if (!window.cy || !window.cy.ready || !cyDataNodes) {
            return;
        }
        cyDataEnabled = settingsPanel.bShowData.checked;
        if (cyDataEnabled) {
            window.cy.add(cyDataNodes);
            window.cy.add(cyDataEdges);
        } else {
            window.cy.remove(cyDataEdges);
            window.cy.remove(cyDataNodes);
        }
    });

    settingsPanel.fitBtn.addEventListener("click", () => {
        if (!window.cy || !window.cy.ready) {
            return;
        }
        window.cy.fit();
    });

    settingsPanel.resetBtn.addEventListener("click", () => {
        if (!window.cy || !window.cy.ready) {
            return;
        }
        window.cy.reset();
    });

    settingsPanel.imgBtn.addEventListener("click", () => {
        if (!window.cy || !window.cy.ready) {
            return;
        }
        let img = window.cy.png();
        let link = document.createElement("a");
        document.body.appendChild(link);
        link.setAttribute("href", img.replace("image/png", "image/octet-stream"));
        link.setAttribute("download", "luna.png");
        link.click();
        link.remove();
    });

    infoPanel.centerBtn.addEventListener("click", () => {
        if (!window.cy || !window.cy.ready) {
            return;
        }
        let { nodeId } = document.querySelector("#info").dataset;
        let node = window.cy.$(`node[id = '${nodeId}']`);
        window.cy.zoom(3);
        window.cy.center(node);
    });

    infoPanel.highlightBtn.addEventListener("click", () => {
        let { nodeId } = document.querySelector("#info").dataset;
        let node = window.cy.$(`node[id = '${nodeId}']`);
        if (node) {
            highlightNode(node);
        }
    });

    infoPanel.lockBtn.addEventListener("click", () => {
        isLocked = !isLocked;
        if (isLocked) {
            infoPanel.lockBtn.innerHTML = "&#128274;&#xFE0E;"; // locked
        } else {
            infoPanel.lockBtn.innerHTML = "&#128275;&#xFE0E;"; // unlocked
        }
    });

    makeCy(style, layout);
}

document.addEventListener("DOMContentLoaded", pageReady);
