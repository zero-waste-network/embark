let async = require('../../utils/async_extend.js');
let SolcW = require('./solcW.js');
const path = require('path');

class Solidity {

  constructor(embark, options) {
    this.embark = embark;
    this.logger = embark.logger;
    this.events = embark.events;
    this.ipc = options.ipc;
    this.solcAlreadyLoaded = false;
    this.solcW = null;
    this.useDashboard = options.useDashboard;
    this.options = embark.config.embarkConfig.options.solc;
    this.storageConfig = embark.config.storageConfig;
    this.providerUrl = null;

    embark.registerCompiler(".sol", this.compile_solidity.bind(this));

    embark.registerAPICall(
      'post',
      '/embark-api/contract/compile',
      (req, res) => {
        if (typeof req.body.code !== 'string') {
          return res.send({error: 'Body parameter \'code\' must be a string'});
        }
        const input = {[req.body.name]: {content: req.body.code.replace(/\r\n/g, '\n')}};
        this.compile_solidity_code(input, {}, true, {}, (errors, result) => {
          const responseData = {errors: errors, result: result};
          this.logger.trace(`POST response /embark-api/contract/compile:\n ${JSON.stringify(responseData)}`);
          res.send(responseData);
        });
      }
    );
  }

  _compile(jsonObj, returnAllErrors, callback) {
    const self = this;
    self.solcW.compile(jsonObj, function (err, output) {
      self.events.emit('contracts:compile:solc', jsonObj);

      if (err) {
        return callback(err);
      }
      if (output.errors && returnAllErrors) {
        return callback(output.errors);
      }

      if (output.errors) {
        for (let i = 0; i < output.errors.length; i++) {
          if (output.errors[i].type === 'Warning') {
            self.logger.warn(output.errors[i].formattedMessage);
          }
          if (output.errors[i].type === 'Error' || output.errors[i].severity === 'error') {
            return callback(new Error("Solidity errors: " + output.errors[i].formattedMessage).message);
          }
        }
      }

      self.events.emit('contracts:compiled:solc', output);
      callback(null, output);
    });
  }

  compile_solidity_code(codeInputs, originalFilepaths, returnAllErrors, options = {}, cb) {
    const self = this;

    async.waterfall([
      function loadCompiler(callback) {
        if (self.solcAlreadyLoaded) {
          return callback();
        }

        let storageConfig = self.storageConfig;
        if (storageConfig && storageConfig.upload && storageConfig.upload.getUrl) {
          self.providerUrl = storageConfig.upload.getUrl;
        }
        self.solcW = new SolcW(self.embark, {logger: self.logger, events: self.events, ipc: self.ipc, useDashboard: self.useDashboard, providerUrl: self.providerUrl});

        self.logger.info(__("loading solc compiler") + "...");
        self.solcW.load_compiler(function (err) {
          self.solcAlreadyLoaded = true;
          callback(err);
        });
      },
      function compileContracts(callback) {
        self.logger.info(__("compiling solidity contracts") + "...");
        let jsonObj = {
          language: 'Solidity',
          sources: codeInputs,
          settings: {
            optimizer: {
              enabled: (!options.isCoverage && self.options.optimize),
              runs: self.options["optimize-runs"]
            },
            outputSelection: {
              '*': {
                '': ['ast', 'legacyAST'], // legacyAST is needed by the debugger, for now
                '*': [
                  'abi',
                  'devdoc',
                  'evm.bytecode',
                  'evm.deployedBytecode',
                  'evm.gasEstimates',
                  'evm.legacyAssembly',
                  'evm.methodIdentifiers',
                  'metadata',
                  'userdoc'
                ]
              }
            }
          }
        };
        self._compile(jsonObj, returnAllErrors, callback);
      },
      function createCompiledObject(output, callback) {
        let json = output.contracts;

        if (!output || !output.contracts) {
          return callback(new Error(__("error compiling for unknown reasons")));
        }

        if (Object.keys(output.contracts).length === 0 && output.sourceList && output.sourceList.length > 0) {
          return callback(new Error(__("error compiling. There are sources available but no code could be compiled, likely due to fatal errors in the solidity code")).message);
        }

        let compiled_object = {};

        for (let contractFile in json) {
          for (let contractName in json[contractFile]) {
            let contract = json[contractFile][contractName];

            const className = contractName;
            let filename = contractFile;

            compiled_object[className] = {};
            compiled_object[className].code = contract.evm.bytecode.object;
            compiled_object[className].linkReferences = contract.evm.bytecode.linkReferences;
            compiled_object[className].runtimeBytecode = contract.evm.deployedBytecode.object;
            compiled_object[className].realRuntimeBytecode = contract.evm.deployedBytecode.object.slice(0, -68);
            compiled_object[className].swarmHash = contract.evm.deployedBytecode.object.slice(-68).slice(0, 64);
            compiled_object[className].gasEstimates = contract.evm.gasEstimates;
            compiled_object[className].functionHashes = contract.evm.methodIdentifiers;
            compiled_object[className].abiDefinition = contract.abi;
            compiled_object[className].userdoc = contract.userdoc;
            compiled_object[className].filename = filename;
            const normalized = path.normalize(filename);
            compiled_object[className].originalFilename = Object.values(originalFilepaths).find(ogFilePath => normalized.indexOf(ogFilePath) > -1);
          }
        }

        callback(null, compiled_object);
      }
    ], function (err, result) {
      cb(err, result);
    });
  }

  compile_solidity(contractFiles, options, cb) {
    if (!contractFiles.length) {
      return cb();
    }
    let self = this;
    let input = {};
    let originalFilepath = {};

    async.waterfall([
      function prepareInput(callback) {
        async.each(contractFiles,
          function (file, fileCb) {
            let filename = file.path;

            for (let directory of self.embark.config.contractDirectories) {
              directory = directory.replace(/\\/g, '/');
              let match = new RegExp("^" + directory);
              filename = filename.replace(match, '');
            }

            originalFilepath[filename] = file.path;

            file.prepareForCompilation(options.isCoverage)
              .then(fileContent => {
                input[file.path] = {content: fileContent.replace(/\r\n/g, '\n')};
                fileCb();
              }).catch((e) => {
                self.logger.error(__('Error while loading the content of ') + filename);
                self.logger.debug(e);
                fileCb();
              });
          },
          function (err) {
            callback(err);
          }
        );
      },
      function compile(callback) {
        self.compile_solidity_code(input, originalFilepath, false, options, callback);
      }
    ], function (err, result) {
      cb(err, result);
    });
  }

}

module.exports = Solidity;
