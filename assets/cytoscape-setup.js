/* eslint-env browser */
/* global cytoscape  */

function pageReady() {
    const settingsPanel = { // settings
        "bShowData": document.querySelector("#bShowData"), // show data (.json files)
        "fitBtn":    document.querySelector("#fitBtn"), // reset cytoscape
        "resetBtn":  document.querySelector("#resetBtn"), // fit cytoscape
        "imgBtn":    document.querySelector("#imgBtn"), // save img cytoscape
        // "backBtn":   document.querySelector("#backBtn"), // back cytoscape
    };
    let cyDataNodes = null;
    let cyDataEdges = null;
    let cyDataEnabled = settingsPanel.bShowData.checked;

    const layout = {
        "name":              "dagre",
        // "rankDir": "LR",
        "rankDir":           "TB",
        // "align":   "UR",
        // "ranker":  "longest-path",
        // "ranker":  "tight-tree",
        // "ranker":  "network-simplex",
        // "nodeSep": 10, // the separation between adjacent nodes in the same rank
        // "edgeSep": 10, // the separation between adjacent edges in the same rank
        // "rankSep": 100, // the separation between each rank in the layout
        "fit":               true, // whether to fit to viewport
        "padding":           50, // fit padding
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
        // "avoidOverlap":                true, // prevents node overlap, may overflow boundingBox if not enough space
        // "nodeDimensionsIncludeLabels": false, // Excludes the label when calculating node bounding boxes for the layout algorithm
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
                "background-color":        "data(color)",
                "label":                   "data(label)",
                "color":                   "data(color)",
                "text-valign":             "center",
                "text-halign":             "center",
                "background-opacity":      1,
                "text-background-opacity": 0.5,
                "text-background-color":   "#000",
                "text-background-padding": 3,
                "text-wrap":               "wrap",
                "text-max-width":          10,
            },
        },
        {
            "selector": ":parent",
            "css":      {
                "background-color":   "data(color)",
                "background-opacity": 0.1,
                "text-valign":        "top",
                "text-halign":        "center",
                "text-transform":     "uppercase",
                "shape":              "star",

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
    ];

    const makeCy = () => {
        window.cy = cytoscape({
            "container":        document.getElementById("cy"),
            "elements":         window.data.main,
            style,
            layout,
            "wheelSensitivity": 0.1,
            "headless":         false,
        });

        window.cy.ready(() => {
            document.querySelector("#loader").style.display = "none";
            cyDataNodes = window.cy.$("node[id $= '.json']");
            cyDataEdges = cyDataNodes.connectedEdges();

            window.cy.expandCollapse({
                "layoutBy": layout,

                "fisheye":           true,
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
            window.cy.nodes().on("expandcollapse.aftercollapse", () => { api.collapseAllEdges(); });
            window.cy.nodes().on("expandcollapse.afterexpand", () => { api.collapseAllEdges(); });
            api.collapse(window.cy.elements("#deps"));
        });

        window.cy.nodes().on("click", (e) => {
            let clickedNode = e.target;
            let id = clickedNode.data("id");
            let library = clickedNode.data("library");

            if (clickedNode.data("parent") === "external" || clickedNode.data("parent") === "deps") {
                let isValidVersion = /^[a-z0-9.]+$/i.test(library.version); // good version validation?
                window.open(`https://www.npmjs.com/package/${library.name}${isValidVersion ? `/v/${library.version}` : ""}`, "_blank");
                return;
            }

            if (!window.data.files[id]) {
                return;
            }

            window.cy = cytoscape({
                "container":        document.getElementById("cy"),
                "elements":         window.data.files[id],
                style,
                layout,
                "wheelSensitivity": 0.1,
                "headless":         false,
            });
        });

        window.cy.on("mouseover", "node[^group]", (evt) => {
            let node = evt.target;
            window.cy.$("node[^group], edge").style({ "opacity": 0.1 });
            node.style({ "opacity": 1 });
            node.predecessors().style({ "opacity": 1 });
            node.successors().style({ "opacity": 1 });
            document.querySelector("#info-content").innerHTML = `<pre>${JSON.stringify(node.data(), null, 2)}</pre>`;
        });

        window.cy.on("mouseout", "node", () => {
            window.cy.$("node[^group], edge").style({ "opacity": 1 });
        });
    };
    makeCy();

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
}

document.addEventListener("DOMContentLoaded", pageReady);
