/*******************************************************************************
 * Copyright (c) 2013 Max Schaefer.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v1.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v10.html
 *
 * Contributors:
 *     Max Schaefer - initial API and implementation
 *******************************************************************************/

const fs = require('fs');
const path = require('path');

var bindings = require('./bindings'),
    astutil = require('./astutil'),
    pessimistic = require('./pessimistic'),
    semioptimistic = require('./semioptimistic'),
    diagnostics = require('./diagnostics'),
    callbackCounter = require('./callbackCounter'),
    requireJsGraph = require('./requireJsGraph');
    ArgumentParser = require('argparse').ArgumentParser;


const findJsFilesInDir = function(dir, filelist) {
    if (dir.endsWith('test') || dir.endsWith('tests') || dir.endsWith('bin') || dir.endsWith('demo')) {
        return filelist;
    }
    const files = fs.readdirSync(dir);
    filelist = filelist || [];
    files.forEach(function(file) {
        if (fs.statSync(path.join(dir, file)).isDirectory()) {
            filelist = findJsFilesInDir(path.join(dir, file), filelist);
        }
        else {
            const filePath = path.join(dir, file);
            if (filePath.toLowerCase().endsWith('.js')) {
                filelist.push(filePath);
            }
        }
    });
    return filelist;
};

var argParser = new ArgumentParser({
    addHelp: true,
    description: 'Call graph generator'
});

argParser.addArgument(
    [ '--fg' ],
    { nargs: 0,
        help: 'print flow graph' }
);

argParser.addArgument(
    [ '--cgPath' ],
    { nargs: '?',
        help: 'if set, will write the call graph to a file' }
);

argParser.addArgument(
    [ '--time' ],
    { nargs: 0,
        help: 'print timings' }
);

argParser.addArgument(
    [ '--strategy' ],
    { help: 'interprocedural propagation strategy; one of NONE, ONESHOT (default), DEMAND, and FULL (not yet implemented) '}
);

argParser.addArgument(
    [ '--countCB' ],
    { nargs: 0,
        help: 'Counts the number of callbacks.'
    }
);

argParser.addArgument(
    [ '--reqJs' ],
    { nargs: 0,
        help: 'Make a RequireJS dependency graph.'
    }
);

var r = argParser.parseKnownArgs();
var args = r[0],
    filesOrModules = r[1];

args.strategy = args.strategy || 'ONESHOT';
if (!args.strategy.match(/^(NONE|ONESHOT|DEMAND|FULL)$/)) {
    argParser.printHelp();
    process.exit(-1);
}
if (args.strategy === 'FULL') {
    console.warn('strategy FULL not implemented yet; using DEMAND instead');
    args.strategy = 'DEMAND';
}

const files = [];
for (const fileOrModule of filesOrModules){
    if (fs.lstatSync(fileOrModule).isDirectory()) {
        const jsFiles = findJsFilesInDir(fileOrModule);
        files.push(...jsFiles);
    }
    else {
        files.push(fileOrModule);
    }
}


var times = [];
if (args.time) console.time("parsing  ");
var ast = astutil.buildAST(files);
if (args.time) console.timeEnd("parsing  ");

if (args.time) console.time("bindings ");
bindings.addBindings(ast);
if (args.time) console.timeEnd("bindings ");

if (args.time) console.time("callgraph");
var cg;
if (args.strategy === 'NONE' || args.strategy === 'ONESHOT')
    cg = pessimistic.buildCallGraph(ast, args.strategy === 'NONE');
else if (args.strategy === 'DEMAND')
    cg = semioptimistic.buildCallGraph(ast);
if (args.time) console.timeEnd("callgraph");

if (args.fg)
    console.log(cg.fg.dotify());

if (args.countCB)
    callbackCounter.countCallbacks(ast);

if (args.reqJs)
    requireJsGraph.makeRequireJsGraph(ast).forEach(function(edge) {
        console.log(edge.toString());
    });

if (args.cgPath) {
    function constructNodeFromCallVertex(callVertex) {
        if (!callVertex.call.attr.hasOwnProperty('enclosingFunction')) {
            return {
                'function_name': 'toplevel',
                "file_name": callVertex.call.attr.enclosingFile,
                'function_position': callVertex.call.loc.start.line + ":" + callVertex.call.loc.start.column,
                'id':  callVertex.attr.node_id
            }
        }

        return undefined;
    }

    function constructNodeFromFuncVertex(funcVertex) {
        if (funcVertex.type === 'NativeVertex') {
            return {
                'function_name': funcVertex.name,
                "file_name": 'native',
                'function_position': '0:0',
                'id':  funcVertex.attr.node_id
            }
        }

        if (funcVertex.type === 'FuncVertex') {
            return {
                'function_name': funcVertex.func.attr.enclosingFile,
                "file_name": funcVertex.func.id.name,
                'function_position': funcVertex.func.id.loc.start.line + ":" + funcVertex.func.id.loc.start.column,
                'id':  funcVertex.attr.node_id
            }
        }

        return undefined;
    }

    function addGraphNode(newNode, graphNodesById) {
        if (newNode !== undefined && !(newNode.id in graphNodesById)) {
            graphNodesById[newNode.id] = newNode;
        }
    }

    function calleeName(callVertex) {
        const callee = callVertex.call.callee;
        if ('object' in callee && 'property' in callee) {
            return callee.object.name + "." + callee.property.name;
        }

        return callee.name;
    }

    function addGraphEdge(callVertex, funcVertex, graphEdges) {
        let sourceId = callVertex.attr.node_id;
        if (callVertex.call.attr.hasOwnProperty('enclosingFunction')) {
            // if the call is from a function, we use that function id as source id instead
            sourceId = callVertex.call.attr.enclosingFunction.attr.func_vertex.attr.node_id;
        }
        let targetId = funcVertex.attr.node_id;
        graphEdges.push({
            'source': sourceId,
            'target': targetId,
            'call_file_path': callVertex.call.attr.enclosingFile,
            'callee_name': calleeName(callVertex),
            'call_position': callVertex.call.loc.start.line + ':' + callVertex.call.loc.start.column
        });
    }

    const graphNodesById = {};
    cg.edges.iter(function (call, fn) {
        const callVertexNode = constructNodeFromCallVertex(call);
        addGraphNode(callVertexNode, graphNodesById);

        const funcVertexNode = constructNodeFromFuncVertex(fn);
        addGraphNode(funcVertexNode, graphNodesById);
    });

    const graphEdges = [];
    cg.edges.iter(function (callVertex, funcVertex) {
        addGraphEdge(callVertex, funcVertex, graphEdges);
    });


    const graphNodes = Object.keys(graphNodesById)
        .map(function(nodeId) { return graphNodesById[nodeId] });


    const callGraph = {
        'directed': true,
        'nodes': graphNodes,
        'links': graphEdges
    };

    var callGraphJson = JSON.stringify(callGraph);

    console.log('Wrote the call graph to ' + args.cgPath);
    fs.writeFileSync(args.cgPath, callGraphJson , 'utf-8');
}
