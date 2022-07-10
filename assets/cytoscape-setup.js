/* eslint-env browser */
/* global cytoscape  */

class LUNA {

    constructor(input) {
        this.cy = null;
        this.cyDataEdges = null;
        this.cyDataEnabled = true;
        this.cyDataNodes = null;
        this.data = input;
        this.isLocked = false;
        this.selectedNodes = new Set();
        this.DOM = {
            "settingsPanel": {
                "container":  document.querySelector("#settings"),
                "bShowData":  document.querySelector("#bShowData"), // show data (.json files)
                "spacing":    document.querySelector("#spacing"), // change spacing
                "layout":     document.querySelector("#layout"), // change layout
                "fileSelect": document.querySelector("#fileSelect"), // select file node to highlight
                "libSelect":  document.querySelector("#libSelect"), // select library node to highlight
                "fitBtn":     document.querySelector("#fitBtn"), // reset cytoscape
                "resetBtn":   document.querySelector("#resetBtn"), // fit cytoscape
                "imgBtn":     document.querySelector("#imgBtn"), // save img cytoscape
            },
            "infoPanel": {
                "container":    document.querySelector("#info"),
                "content":      document.querySelector("#info-content"),
                "centerBtn":    document.querySelector("#centerBtn"), // center node
                "highlightBtn": document.querySelector("#highlightBtn"), // highlight node
                "lockBtn":      document.querySelector("#lockBtn"), // highlight node
            },
        };
    }

    fade(element) {
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

    unfade(element) {
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

    setInfoPanel({ id, type, library, size, filePath, isData, label, parent }) {
        this.DOM.infoPanel.container.style.display = "block";
        this.DOM.infoPanel.container.dataset.nodeId = id;
        let html = `<table><tr><td><b>Label:</b></td><td>${label}</td></tr>`;
        if (!type) {
            type = "unknown";
            if (isData) {
                type = "data";
            } else if (library) {
                type = "library";
            } else if (filePath) {
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
                html += `<tr><td><b>NPM:</b></td><td><a href="https://www.npmjs.com/package/${library.name}${isValidVersion ? `/v/${library.version}` : ""}" target="_blank">${library.name}</a> &#128279;&#xFE0E;</td></tr>`;
            }
        }
        if (size) {
            html += `<tr><td><b>LOC:</b></td><td>${size.loc}</td></tr>`;
            html += `<tr><td><b>Characters:</b></td><td>${size.chars}</td></tr>`;
        }
        if (filePath) {
            html += `<tr><td><b>Path:</b></td><td><a href="${filePath}" target="_blank">${filePath}</a> &#128279;&#xFE0E;</td></tr>`;
        }
        html += "</table><br>";
        this.DOM.infoPanel.content.innerHTML = html;
    }

    highlightNodes() {
        if (this.selectedNodes.size === 0) {
            this.cy.$("node, edge").style({ "opacity": 1, "target-arrow-shape": "triangle" });
            this.DOM.infoPanel.highlightBtn.innerHTML = "Highlight";
        } else {
            this.cy.$("node, edge").style({ "opacity": 0.1, "target-arrow-shape": "none" });
            this.cy.$("node:compound").style({ "opacity": 1, "target-arrow-shape": "triangle" });
            for (let id of this.selectedNodes) {
                let node = this.cy.$id(id);
                node.style({ "opacity": 1 });
                node.predecessors().style({ "opacity": 1, "target-arrow-shape": "triangle" });
                node.successors().style({ "opacity": 1, "target-arrow-shape": "triangle" });
            }
            this.DOM.infoPanel.highlightBtn.innerHTML = "Undo";
        }
    }

    makeCy(style, layouts) {
        let layout = layouts.layered;
        this.DOM.settingsPanel.layout.value = "layered";
        layout.fit = true;
        this.cy = cytoscape({
            "container":           document.getElementById("cy"),
            "elements":            this.data,
            style,
            layout,
            "wheelSensitivity":    0.1,
            "pixelRatio":          1.0,
            "boxSelectionEnabled": false,
        });

        this.cy.ready(() => {
            this.fade(document.getElementById("loader"));
            // this.cyDataNodes = this.cy.$("node[id $= '.json']");
            this.cyDataNodes = this.cy.$("node[?isData]");
            this.cyDataEdges = this.cyDataNodes.connectedEdges();

            this.cy.expandCollapse({
                "layoutBy": layout,
                "ready":    () => setTimeout(() => {
                    // prevent view from changing when expanding/collapsing
                    let api = this.cy.expandCollapse("get");
                    layout.fit = false;
                    layout.animate = true;
                    api.setOption("layoutBy", layout);
                    this.cy.fit();
                }, 3000), // apparently ready does not truly mean ready
                "fisheye":                        false,
                "animate":                        false,
                "animationDuration":              1500,
                "undoable":                       false,
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
            let api = this.cy.expandCollapse("get");
            this.cy.nodes().on("expandcollapse.aftercollapse", (evt) => {
                evt.target.data("collapsed", false);
                // api.collapseAllEdges();
                for (let node of evt.target.connectedEdges()
                    .connectedNodes()) {
                    api.collapseEdges(node.edgesWith(evt.target));
                }

                this.selectedNodes.delete(evt.target.id());
                this.highlightNodes();
            });
            this.cy.nodes().on("expandcollapse.afterexpand", (evt) => {
                evt.target.data("collapsed", true);
                this.selectedNodes.delete(evt.target.id());
                this.highlightNodes();
                // this.DOM.infoPanel.centerBtn.click();
                let children = evt.target.children();
                for (let node of evt.target.children().connectedEdges()
                    .connectedNodes()
                    .not(children)) {
                    api.collapseEdges(node.edgesWith(children));
                }
                for (let node of evt.target.connectedEdges()
                    .connectedNodes()) {
                    api.collapseEdges(node.edgesWith(evt.target));
                }
            });
            // api.collapse(this.cy.elements("#deps, node[group][library], node[group][filePath], node[group][isFolder]")); // TODO: fix this
            api.collapse(this.cy.elements("#deps, node[group][library], node[group][filePath]"));
        });

        let lastEvt = null;
        this.cy.nodes().on("click", (evt) => {
            // prevent duplicate event firing
            if (lastEvt && lastEvt.timeStamp === evt.timeStamp && lastEvt.position.x === evt.position.x && lastEvt.position.y === evt.position.y) {
                return;
            }
            lastEvt = evt;
            let node = evt.target;
            if (evt.originalEvent.shiftKey && !node.is(":compound")) {
                if (!this.selectedNodes.has(node.id())) {
                    this.selectedNodes.add(node.id());
                } else if (this.selectedNodes.has(node.id()) && this.isLocked) {
                    this.selectedNodes.delete(node.id());
                }

                if (this.isLocked && this.selectedNodes.size === 0) {
                    this.DOM.infoPanel.lockBtn.click();
                } else if (this.selectedNodes.size > 0 && !this.isLocked) {
                    this.DOM.infoPanel.lockBtn.click();
                }

                this.highlightNodes();
            }
        });

        this.cy.on("mouseover", "node[^group], node[library], node[filePath]", (evt) => {
            if (this.isLocked) {
                return;
            }
            let node = evt.target;
            if (node.is(":compound")) {
                return;
            }
            this.setInfoPanel(node.data());
            this.selectedNodes.clear();
            this.selectedNodes.add(node.id());
            this.highlightNodes();
        });

        this.cy.on("mouseout", "node", (evt) => {
            if (this.isLocked) {
                return;
            }
            let node = evt.target;
            if (node.is(":compound")) {
                return;
            }
            this.selectedNodes.clear();
            this.highlightNodes();
        });
    }

    shine() {
        this.cyDataEnabled = this.DOM.settingsPanel.bShowData.checked;

        const layouts = {
            "cose-bilkent": {
                "name":                        "cose-bilkent",
                // 'draft', 'default' or 'proof"
                // - 'draft' fast cooling rate
                // - 'default' moderate cooling rate
                // - "proof" slow cooling rate
                "quality":                     "default",
                // Whether to include labels in node dimensions. Useful for avoiding label overlap
                "nodeDimensionsIncludeLabels": true,
                // number of ticks per frame; higher is faster but more jerky
                "refresh":                     30,
                // Whether to fit the network view after when done
                "fit":                         true,
                // Padding on fit
                "padding":                     10,
                // Whether to enable incremental mode
                "randomize":                   true,
                // Node repulsion (non overlapping) multiplier
                "nodeRepulsion":               4500,
                // Ideal (intra-graph) edge length
                "idealEdgeLength":             50,
                // Divisor to compute edge forces
                "edgeElasticity":              0.45,
                // Nesting factor (multiplier) to compute ideal edge length for inter-graph edges
                "nestingFactor":               0.1,
                // Gravity force (constant)
                "gravity":                     0.25,
                // Maximum number of iterations to perform
                "numIter":                     2500,
                // Whether to tile disconnected nodes
                "tile":                        true,
                // Type of layout animation. The option set is {'during', 'end', false}
                "animate":                     "end",
                // Duration for animate:end
                "animationDuration":           500,
                // Amount of vertical space to put between degree zero nodes during tiling (can also be a function)
                "tilingPaddingVertical":       10,
                // Amount of horizontal space to put between degree zero nodes during tiling (can also be a function)
                "tilingPaddingHorizontal":     10,
                // Gravity range (constant) for compounds
                "gravityRangeCompound":        1.0,
                // Gravity force (constant) for compounds
                "gravityCompound":             10.0,
                // Gravity range (constant)
                "gravityRange":                3.8,
                // Initial cooling factor for incremental layout
                "initialEnergyOnIncremental":  0.5,
                "spacingFactor":               1.0, // positive spacing factor, larger => more space between nodes (N.B. n/a if causes overlap)
            },

            "cola": {
                "name":                        "cola",
                "animate":                     true, // whether to show the layout as it's running
                "refresh":                     1, // number of ticks per frame; higher is faster but more jerky
                "maxSimulationTime":           4000, // max length in ms to run the layout
                "ungrabifyWhileSimulating":    false, // so you can't drag nodes during layout
                "fit":                         true, // on every layout reposition of nodes, fit the viewport
                "padding":                     30, // padding around the simulation
                "boundingBox":                 undefined, // constrain layout bounds; { x1, y1, x2, y2 } or { x1, y1, w, h }
                "nodeDimensionsIncludeLabels": true, // whether labels should be included in determining the space used by a node
                "randomize":                   false, // use random node positions at beginning of layout
                "avoidOverlap":                true, // if true, prevents overlap of node bounding boxes
                "handleDisconnected":          true, // if true, avoids disconnected components from overlapping
                "convergenceThreshold":        0.01, // when the alpha value (system energy) falls below this value, the layout stops
                // "nodeSpacing":                 () => 10, // extra spacing around nodes
                "spacingFactor":               1.0, // positive spacing factor, larger => more space between nodes (N.B. n/a if causes overlap)
                "flow":                        { "axis": "y", "minSeparation": 30 }, // use DAG/tree flow layout if specified, e.g. { axis: 'y', minSeparation: 30 }
                "alignment":                   undefined, // relative alignment constraints on nodes, e.g. {vertical: [[{node: node1, offset: 0}, {node: node2, offset: 5}]], horizontal: [[{node: node3}, {node: node4}], [{node: node5}, {node: node6}]]}
                "gapInequalities":             undefined, // list of inequality constraints for the gap between the nodes, e.g. [{"axis":"y", "left":node1, "right":node2, "gap":25}]
                "centerGraph":                 true, // adjusts the node positions initially to center the graph (pass false if you want to start the layout from the current position)
                "edgeLength":                  undefined, // sets edge length directly in simulation
                "edgeSymDiffLength":           undefined, // symmetric diff edge length in simulation
                "edgeJaccardLength":           undefined, // jaccard edge length in simulation
                "unconstrIter":                undefined, // unconstrained initial layout iterations
                "userConstIter":               undefined, // initial layout iterations with user-specified constraints
                "allConstIter":                undefined, // initial layout iterations with all constraints including non-overlap
            },

            "mrtree": {
                "name":                        "elk",
                "nodeDimensionsIncludeLabels": true, // Boolean which changes whether label dimensions are included when calculating node dimensions
                "fit":                         true, // Whether to fit
                "ranker":                      "longest-path",
                "animate":                     true,
                "animationDuration":           1500,
                "animationEasing":             "ease-in-out-cubic",
                "spacingFactor":               1.0, // positive spacing factor, larger => more space between nodes (N.B. n/a if causes overlap)
                "elk":                         {
                    "zoomToFit":                   true,
                    "omitNodeMicroLayout":         true,
                    "algorithm":                   "mrtree",
                    "separateConnectedComponents": true,
                    "direction":                   "DOWN",
                },
            },

            "layered": {
                "name":                        "elk",
                "nodeDimensionsIncludeLabels": true, // Boolean which changes whether label dimensions are included when calculating node dimensions
                "fit":                         true, // Whether to fit
                "ranker":                      "longest-path",
                "animate":                     true,
                "animationDuration":           1500,
                "animationEasing":             "ease-in-out-cubic",
                "spacingFactor":               1.0, // positive spacing factor, larger => more space between nodes (N.B. n/a if causes overlap)
                // "padding":                     50, // Padding on fit
                // "animateFilter":               (node, i) => true, // Whether to animate specific nodes when animation is on; non-animated nodes immediately go to their final positions
                // "animationEasing":             undefined, // Easing of animation if enabled
                // "transform": (node, pos) => {
                //     if (node.data("id") === "files" || node.data("parent") === "files") {
                //         let xs = this.cy.$("node[parent='files']").map((n) => n.position("x"));
                //         let xMin = Math.min(...xs);
                //         let xMax = Math.max(...xs);
                //         let xDelta = pos.x - xMin;
                //         console.log({ xMin, xMax, xDelta });
                //         return {
                //             "x": (this.cy.width() / 2) + xDelta - ((xMax - xMin) / 2),
                //             "y": pos.y - (this.cy.height() / 4),
                //         };
                //     }
                //     if (node.data("id") === "deps" || node.data("parent") === "deps") {
                //         return {
                //             "x": pos.x - (this.cy.width() / 2),
                //             "y": pos.y + (this.cy.height() / 4),
                //         };
                //     }
                //     return pos;
                // }, // A function that applies a transform to the final node position
                // "ready":                       undefined, // Callback on layoutready
                // "stop":                        undefined, // Callback on layoutstop
                "elk":                         {
                // All options are available at http://www.eclipse.org/elk/reference.html
                //
                // 'org.eclipse.' can be dropped from the identifier. The subsequent identifier has to be used as property key in quotes.
                // E.g. for 'org.eclipse.elk.direction' use:
                // 'elk.direction'
                //
                // Enums use the name of the enum as string e.g. instead of Direction.DOWN use:
                // 'elk.direction': 'DOWN'
                //
                // The main field to set is `algorithm`, which controls which particular layout algorithm is used.
                // Example (downwards layered layout):
                    "zoomToFit":     true,
                    "algorithm":     "layered",
                    "elk.direction": "DOWN",
                },
                // // "priority": (edge) => null, // Edges with a non-nil value are skipped when geedy edge cycle breaking is enabled
            },

            "breadthfirst": {
                "name":                        "breadthfirst",
                "fit":                         true, // whether to fit the viewport to the graph
                "directed":                    true, // whether the tree is directed downwards (or edges can point in any direction if false)
                // "padding":                     0, // padding on fit
                // "circle":                      false, // put depths in concentric circles if true, put depths top down if false
                "grid":                        false, // whether to create an even grid into which the DAG is placed (circle:false only)
                "spacingFactor":               0.25, // positive spacing factor, larger => more space between nodes (N.B. n/a if causes overlap)
                // "boundingBox":                 undefined, // constrain layout bounds; { x1, y1, x2, y2 } or { x1, y1, w, h }
                "avoidOverlap":                true, // prevents node overlap, may overflow boundingBox if not enough space
                "nodeDimensionsIncludeLabels": true, // Excludes the label when calculating node bounding boxes for the layout algorithm
                "roots":                       "#files, node[?isMain]", // the roots of the trees
                // "maximal":                     true, // whether to shift nodes down their natural BFS depths in order to avoid upwards edges (DAGS only)
                // "depthSort":                   undefined, // a sorting function to order nodes at equal depth. e.g. function(a, b){ return a.data('weight') - b.data('weight') }
                "animate":                     false, // whether to transition the node positions
                "animationDuration":           1500, // duration of animation in ms if enabled
            },
        };

        const maxSize = Math.max(...this.data.filter((e) => e.data.size).map((e) => e.data.size.loc));
        const style = [
            {
                "selector": "node",
                "style":    {
                    "width":                      (n) => (n.data("size.loc") ? (25 + ((n.data("size.loc") * 75) / maxSize)) : 50), // between 25 and 100
                    "height":                     (n) => (n.data("size.loc") ? (25 + ((n.data("size.loc") * 75) / maxSize)) : 50),
                    "background-color":           "data(color)",
                    "label":                      "data(label)",
                    "color":                      "data(color)",
                    "text-valign":                "center",
                    "text-halign":                "center",
                    "background-opacity":         1,
                    "text-background-opacity":    0.75,
                    "text-background-color":      "#000",
                    "text-background-padding":    4,
                    "text-background-shape":      "round-rectangle",
                    "text-wrap":                  "wrap",
                    "text-overflow-wrap":         "anywhere",
                    // "text-max-width":             80,
                    // "text-rotation":           "10deg",
                    "compound-sizing-wrt-labels": "include",
                },
            },
            {
                "selector": ":parent, node[?group][^library][^filePath]",
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
                    "width":              1,
                    // "line-color":         "data(color)",
                    "line-color":         (n) => n.data("color") || "#fff",
                    // "target-arrow-color": "data(color)",
                    "target-arrow-color": (n) => n.data("color") || "#fff",
                    "target-arrow-shape": "triangle",
                    "arrow-scale":        1,
                    "curve-style":        "bezier",
                },
            },
            // {
            //     "selector": "node[?group][^collapsed]:childless",
            //     "style":    { "display": "none" },
            // },
            {
                "selector": "node[filePath]",
                "style":    {
                    "background-image":             "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTAwIiBoZWlnaHQ9IjEwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB2ZXJzaW9uPSIxLjAiPjxnIGNsYXNzPSJwcmVmaXhfX2xheWVyIj48cGF0aCBkPSJNNjMuMzMgMzYuNjdBNi42NyA2LjY3IDAgMDE1Ni42NyAzMFYxMEgyMy4zM2E2LjY2IDYuNjYgMCAwMC02LjY2IDYuNjd2NjYuNjZBNi42NyA2LjY3IDAgMDAyMy4zMyA5MGg1My4zNGE2LjY3IDYuNjcgMCAwMDYuNjYtNi42N1YzNi42N2gtMjB6bS0yMi44NCAzNC44TDM2Ljk1IDc1bC05LjMxLTkuMzFhMy4zMyAzLjMzIDAgMDEwLTQuNzFsOS4zMS05LjMxIDMuNTQgMy41My04LjEzIDguMTMgOC4xMyA4LjEzdi4wMXptMTAuMzYgNS4yaC01LjA0TDQ5LjE1IDUwaDUuMDRsLTMuMzQgMjYuNjd6bTIxLjUxLTEwLjk4TDYzLjA1IDc1bC0zLjU0LTMuNTMgOC4xMy04LjE0LTguMTMtOC4xMyAzLjU0LTMuNTMgOS4zMSA5LjMxYTMuMzMgMy4zMyAwIDAxMCA0LjcxeiIgZmlsbD0iI2ZmZiIvPjxwYXRoIGQ9Ik02My4zMyAzMGgyMGwtMjAtMjB2MjB6IiBmaWxsPSIjZmZmIi8+PC9nPjwvc3ZnPg==",
                    // "background-fit":               "cover cover",
                    "background-fit":               "contain",
                    "background-image-containment": "over",
                    "background-clip":              "none",
                    "background-opacity":           "0",
                    "border-width":                 0,
                    // "width":                        50,
                    // "height":                       50,
                },
            },
            {
                "selector": "node[filePath]:compound",
                "style":    {
                    "background-image-opacity": "0.1",
                    "background-opacity":       "0.1",
                    "border-width":             1,
                },
            },
            {
                "selector": "node[?isFolder]",
                "style":    {
                // "background-image":             "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0yIDlhMyAzIDAgMDEzLTNoMTRhMyAzIDAgMDEzIDN2OGEzIDMgMCAwMS0zIDNINWEzIDMgMCAwMS0zLTNWOXptMy0xYTEgMSAwIDAwLTEgMXY4YTEgMSAwIDAwMSAxaDE0YTEgMSAwIDAwMS0xVjlhMSAxIDAgMDAtMS0xSDV6IiBmaWxsPSIjZmZmIi8+PHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0yIDdhMyAzIDAgMDEzLTNoNmEzIDMgMCAwMTMgMyAxIDEgMCAxMS0yIDAgMSAxIDAgMDAtMS0xSDVhMSAxIDAgMDAtMSAxdjJhMSAxIDAgMDEtMiAwVjd6IiBmaWxsPSIjZmZmIi8+PC9zdmc+",
                    "background-image":             "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjI1LjY5MyIgaGVpZ2h0PSIyMjUuNjkzIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxnIGNsYXNzPSJwcmVmaXhfX2xheWVyIj48cGF0aCBkPSJNOC40MyA3OC4zNWgyMDguODRjMi4zOSAwIDQuNTkuOTcgNi4yMSAyLjczczIuMzkgNC4wNCAyLjE4IDYuNDJsLTEwLjIyIDExNy4xNWMtLjM5IDQuMzktMy45OSA3LjctOC40IDcuN0gyMS40Yy00LjMgMC03LjktMy4yMy04LjM3LTcuNUwuMDUgODcuN2MtLjI2LTIuNDIuNDgtNC43NCAyLjEtNi41NSAxLjYyLTEuODEgMy44NS0yLjggNi4yOC0yLjh6bTIwNi4wOC0xNVY0NC44MWMwLTQuMTQtMi41Mi03LjQ2LTYuNjYtNy40NmgtODMuMzR2LTIuMzRjMC0xMi4yMi04LjE3LTIxLjY2LTE5LjI1LTIxLjY2SDMwLjQzYy0xMS4wNyAwLTIwLjkyIDkuNDQtMjAuOTIgMjEuNjZ2MjQuOTVjMCAxLjIzLjY4IDIuMzggMS4yNyAzLjM5aDIwMy43M3oiIGZpbGw9IiNmZmYiLz48L2c+PC9zdmc+",
                    "background-fit":               "contain",
                    "background-image-containment": "over",
                    "background-clip":              "none",
                    "background-opacity":           "0",
                    "border-width":                 0,
                    // "width":                        50,
                    // "height":                       50,
                },
            },
            {
                "selector": "node[?isFolder]:compound",
                "style":    {
                // "background-image-opacity": "0.1",
                    "background-image-opacity": "0",
                    "background-opacity":       "0.1",
                    "border-width":             1,
                },
            },
            {
                "selector": "node[library]",
                "style":    {
                    "background-image":             "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBjbGFzcz0icHJlZml4X19sYXllciI+PHBhdGggZD0iTTY0IDQ3OUg0OGEzMiAzMiAwIDAxLTMyLTMyVjExMWEzMiAzMiAwIDAxMzItMzJoMTZhMzIgMzIgMCAwMTMyIDMydjMzNmEzMiAzMiAwIDAxLTMyIDMyek0yNDAgMTc1YTMyIDMyIDAgMDAtMzItMzJoLTY0YTMyIDMyIDAgMDAtMzIgMzJ2MjhhNCA0IDAgMDA0IDRoMTIwYTQgNCAwIDAwNC00di0yOHpNMTEyIDQ0N2EzMiAzMiAwIDAwMzIgMzJoNjRhMzIgMzIgMCAwMDMyLTMydi0zMGEyIDIgMCAwMC0yLTJIMTE0YTIgMiAwIDAwLTIgMnYzMHoiIGZpbGw9IiNmZmYiLz48cmVjdCBmaWxsPSIjZmZmIiBoZWlnaHQ9IjE0NCIgcng9IjIiIHJ5PSIyIiB3aWR0aD0iMTI4IiB4PSIxMTIiIHk9IjIzOSIvPjxwYXRoIGQ9Ik0zMjAgNDc5aC0zMmEzMiAzMiAwIDAxLTMyLTMyVjYzYTMyIDMyIDAgMDEzMi0zMmgzMmEzMiAzMiAwIDAxMzIgMzJ2Mzg0YTMyIDMyIDAgMDEtMzIgMzJ6TTQ5NS44OSA0NDUuNDVsLTMyLjIzLTM0MGMtMS40OC0xNS42NS0xNi45NC0yNy0zNC41My0yNS4zMWwtMzEuODUgM2MtMTcuNTkgMS42Ny0zMC42NSAxNS43MS0yOS4xNyAzMS4zNmwzMi4yMyAzNDBjMS40OCAxNS42NSAxNi45NCAyNyAzNC41MyAyNS4zMWwzMS44NS0zYzE3LjU5LTEuNjcgMzAuNjUtMTUuNzEgMjkuMTctMzEuMzZ6IiBmaWxsPSIjZmZmIi8+PC9nPjwvc3ZnPg==",
                    "background-fit":               "contain",
                    "background-image-containment": "inside",
                    "background-clip":              "none",
                    "background-opacity":           "0.5",
                    "border-width":                 0,
                    // "width":                        50,
                    // "height":                       50,
                },
            },
            {
                "selector": "node[library]:compound",
                "style":    {
                    "background-image-opacity": "0.1",
                    "background-opacity":       "0.1",
                    "border-width":             1,
                },
            },
            {
                "selector": "node[?isData]",
                "style":    {
                    "background-image":             "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGcgY2xhc3M9InByZWZpeF9fbGF5ZXIiPjxwYXRoIGQ9Ik0xMi44MiAxNS4xMmMtLjUxIDAtLjgxLjQ5LS44MSAxLjE1IDAgLjY2LjMxIDEuMTIuODIgMS4xMnMuODEtLjQ5LjgxLTEuMTRjMC0uNjEtLjI5LTEuMTMtLjgyLTEuMTN6IiBmaWxsPSIjZmZmIi8+PHBhdGggZD0iTTE0IDJINmEyIDIgMCAwMC0yIDJ2MTZhMiAyIDAgMDAyIDJoMTJhMiAyIDAgMDAyLTJWOGwtNi02ek04LjAyIDE2LjdjMCAuOTYtLjQ2IDEuMy0xLjIgMS4zLS4xNyAwLS40LS4wMy0uNTYtLjA4bC4wOS0uNjFjLjExLjAzLjI0LjA2LjM5LjA2LjMyIDAgLjUyLS4xNS41Mi0uNjd2LTIuMTNoLjc2djIuMTN6TTkuNDggMThjLS4zOCAwLS43Ny0uMTEtLjk1LS4yMWwuMTUtLjYzYy4yLjEuNTIuMjEuODUuMjEuMzUgMCAuNTMtLjE1LjUzLS4zNiAwLS4yMi0uMTYtLjM0LS41Ni0uNDgtLjU2LS4yLS45My0uNTEtLjkzLTEgMC0uNTcuNDgtMS4wMSAxLjI4LTEuMDEuMzggMCAuNjYuMDguODYuMTdsLS4xNy42MWMtLjE0LS4wNi0uMzgtLjE2LS43MS0uMTZzLS40OS4xNS0uNDkuMzNjMCAuMjEuMTkuMzEuNjMuNDcuNTkuMjIuODcuNTMuODcgMS4wMSAwIC41Ny0uNDMgMS4wNS0xLjM2IDEuMDV6bTMuMzEgMGMtMSAwLTEuNTktLjc1LTEuNTktMS43MiAwLTEuMDEuNjUtMS43NiAxLjY0LTEuNzYgMS4wNCAwIDEuNi43NyAxLjYgMS43IDAgMS4xMS0uNjcgMS43OC0xLjY1IDEuNzh6bTQuOTQtLjA1aC0uOGwtLjcyLTEuMzFhMTIuNjQgMTIuNjQgMCAwMS0uNTgtMS4xOWwtLjAyLjAxYy4wMi40NC4wMy45Mi4wMyAxLjQ3djEuMDJoLS43di0zLjM4aC44OWwuNyAxLjI0Yy4yLjM1LjQuNzcuNTUgMS4xNWguMDJjLS4wNS0uNDQtLjA3LS45LS4wNy0xLjR2LS45OWguN3YzLjM4ek0xNCA5aC0xVjRsNSA1aC00eiIgZmlsbD0iI2ZmZiIvPjwvZz48L3N2Zz4=",
                    "background-fit":               "contain",
                    "background-image-containment": "over",
                    "background-clip":              "none",
                    "background-opacity":           "0",
                    "border-width":                 0,
                    // "width":                        50,
                    // "height":                       50,
                },
            },
            {
                "selector": "node[?isMain]",
                "style":    {
                    // "width":            50,
                    // "height":           50,
                    "background-color": "black",
                    "border-color":     "white",
                    "border-width":     3,

                },
            },
        ];

        this.DOM.settingsPanel.bShowData.addEventListener("input", () => {
            if (!this.cy || !this.cy.ready || !this.cyDataNodes) {
                return;
            }
            this.cyDataEnabled = this.DOM.settingsPanel.bShowData.checked;
            if (this.cyDataEnabled) {
                this.cy.add(this.cyDataNodes);
                this.cy.add(this.cyDataEdges);
            } else {
                this.cy.remove(this.cyDataEdges);
                this.cy.remove(this.cyDataNodes);
            }
        });

        let changeLayout = () => {
            if (!this.cy || !this.cy.ready) {
                return;
            }

            let api = this.cy.expandCollapse("get");
            let name = this.DOM.settingsPanel.layout.value;
            let spacing = this.DOM.settingsPanel.spacing.value;
            let layout = layouts[name];
            layout.fit = true;
            layout.animate = true;
            layout.spacingFactor = spacing;
            if (name === "cola") {
                layout.nodeSpacing = () => spacing;
            }
            api.setOption("layoutBy", layout);
            this.cy.layout(layout).run();
        };
        this.DOM.settingsPanel.spacing.addEventListener("input", changeLayout);
        this.DOM.settingsPanel.layout.addEventListener("input", changeLayout);

        this.DOM.settingsPanel.fitBtn.addEventListener("click", () => {
            if (!this.cy || !this.cy.ready) {
                return;
            }
            this.cy.fit();
        });

        this.DOM.settingsPanel.resetBtn.addEventListener("click", () => {
            if (!this.cy || !this.cy.ready) {
                return;
            }
            this.cy.reset();
        });

        this.DOM.settingsPanel.imgBtn.addEventListener("click", () => {
            if (!this.cy || !this.cy.ready) {
                return;
            }
            let img = this.cy.png();
            let link = document.createElement("a");
            document.body.appendChild(link);
            link.setAttribute("href", img.replace("image/png", "image/octet-stream"));
            link.setAttribute("download", "luna.png");
            link.click();
            link.remove();
        });

        this.DOM.infoPanel.centerBtn.addEventListener("click", () => {
            if (!this.cy || !this.cy.ready) {
                return;
            }
            let { nodeId } = this.DOM.infoPanel.container.dataset;
            let node = this.cy.$id(nodeId);
            this.cy.zoom(3);
            this.cy.center(node);
        });

        this.DOM.infoPanel.highlightBtn.addEventListener("click", () => {
            let { nodeId } = this.DOM.infoPanel.container.dataset;
            if (nodeId) {
                if (this.selectedNodes.size === 0) {
                    this.selectedNodes.add(nodeId);
                    if (!this.isLocked) {
                        this.DOM.infoPanel.lockBtn.click();
                    }
                } else {
                    this.selectedNodes.clear();
                    if (this.isLocked) {
                        this.DOM.infoPanel.lockBtn.click();
                    }
                }
            }
            this.highlightNodes();
        });

        this.DOM.infoPanel.lockBtn.addEventListener("click", () => {
            this.isLocked = !this.isLocked;
            if (this.isLocked) {
                this.DOM.infoPanel.lockBtn.innerHTML = "&#128274;&#xFE0E;"; // locked
            } else {
                this.DOM.infoPanel.lockBtn.innerHTML = "&#128275;&#xFE0E;"; // unlocked
            }
        });

        let fileSelect = this.data.filter((e) => e.data.filePath).reduce((o, e) => {
            let basepath = e.data.id.replace(e.data.label, "") || "(root)";
            o[basepath] = o[basepath] || [];
            o[basepath].push(e.data);
            return o;
        }, {});
        let fileSelectHTML = Object.keys(fileSelect).sort()
            .map((basepath) => {
                let files = fileSelect[basepath].sort();
                let html = `<optgroup label="${basepath}">`;
                files.reverse().forEach((file) => {
                    html += `<option value="${file.id}">${file.label}</option>`;
                });
                html += "</optgroup>";
                return html;
            })
            .join("");
        this.DOM.settingsPanel.fileSelect.innerHTML = fileSelectHTML;
        this.DOM.settingsPanel.fileSelect.addEventListener("change", () => {
            let file = this.DOM.settingsPanel.fileSelect.value;
            this.selectedNodes.clear();
            this.selectedNodes.add(file);
            let node = this.cy.$id(file);
            if (node.length) { this.setInfoPanel(node.data()); }
            if (!this.isLocked) {
                this.DOM.infoPanel.lockBtn.click();
            }
            this.highlightNodes();
        });

        let libSelectHTML = [...new Set(this.data.filter((e) => e.data.library).map((e) => `<option value="${e.data.id}">${e.data.label}</option>`))]
            .sort()
            .join("");
        this.DOM.settingsPanel.libSelect.innerHTML = libSelectHTML;
        this.DOM.settingsPanel.libSelect.addEventListener("input", () => {
            let lib = this.DOM.settingsPanel.libSelect.value;
            this.selectedNodes.clear();
            this.selectedNodes.add(lib);
            let node = this.cy.$id(lib);
            if (node.length) { this.setInfoPanel(node.data()); }
            if (!this.isLocked) {
                this.DOM.infoPanel.lockBtn.click();
            }
            this.highlightNodes();
        });

        this.makeCy(style, layouts);
    }

}

document.addEventListener("DOMContentLoaded", function pageReady() {
    window.luna = new LUNA(window.data.reverse());
    window.luna.shine();
});
