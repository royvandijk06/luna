# LUNA: Library Usage in Node.js Analyzer

<center><img src="luna.png" alt="luna"></center>

## Description
LUNA is a software development tool for node.js projects, with a focus on libraries. The goal of LUNA is to aid developers in better understanding how libraries are being utilized in their projects.

## Usage
Inside any node.js project, run:
```bash
npx luna-scanner
```
After analyzing the source code, it will generate a luna report, which includes a visualization about the interaction between source code and libraries.

## Report Manual
 * Drag (click and hold) the mouse to pan around or move nodes around
 * Use the mouse wheel to zoom in or out
 * Hovering over a node will display information on the bottom left and highlight connected nodes
 * Using Shift + Click on a node will lock it, so that focus remains on this node (Shift + Click node again to unlock)
 * Double Click nodes or groups in the graph or menu to collapse/expand them
 * Use the menu on the left to manipulate the graph:
    1. Adjust the scale of the graph / space between nodes
    2. Adjust the layout of the graph / position of the nodes
    3. Hide a selection of nodes (representing libraries or files)
    4. Highlight a selection of nodes (representing libraries or files)
 * Hover your mouse above menu items to find more information about their functionality