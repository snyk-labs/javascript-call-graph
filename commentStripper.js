var esprima = require('./esprima'),
    escodegen = require('escodegen'),
    ArgumentParser = require('argparse').ArgumentParser,
    fs = require('fs');

var argParser = new ArgumentParser({
    addHelp: true,
    description: 'JavaScript comment stripper'
});

var r = argParser.parseKnownArgs();
var file = r[1][0];

var source = fs.readFileSync(file, 'utf-8');
var parsed = esprima.parse(source);
var stripped = escodegen.generate(parsed);
console.log(stripped);