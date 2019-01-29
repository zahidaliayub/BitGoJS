const BaseCoin = require('../baseCoin');
const config = require('../../config');
const bitcoin = require('bitgo-utxo-lib');
const bitcoinMessage = require('bitcoinjs-message');
const Promise = require('bluebird');
const co = Promise.coroutine;
const prova = require('prova-lib');
const crypto = require('crypto');
const request = require('superagent');
const _ = require('lodash');
const RecoveryTool = require('../recovery');
const errors = require('../../errors');
const debug = require('debug')('bitgo:v2:utxo');

class AbstractUtxoCoin extends BaseCoin {
  constructor(network) {
    super();
    if (!_.isObject(network)) {
      throw new Error('network must be an object');
    }
    this._network = network;
  }

  get network() {
    return this._network;
  }

  static get validAddressTypes() {
    return _.values(this.AddressTypes);
  }

  /**
   * Returns the factor between the base unit and its smallest subdivison
   * @return {number}
   */
  getBaseFactor() {
    return 1e8;
  }

  getCoinLibrary() {
    return bitcoin;
  }

  isValidAddress(address, forceAltScriptSupport) {
    const validVersions = [
      this.network.pubKeyHash,
      this.network.scriptHash
    ];
    if (this.altScriptHash && (forceAltScriptSupport || this.supportAltScriptDestination)) {
      validVersions.push(this.altScriptHash);
    }

    let addressDetails;
    try {
      addressDetails = this.getCoinLibrary().address.fromBase58Check(address);
    } catch (e) {
      if (!this.supportsP2wsh()) {
        return false;
      }

      try {
        addressDetails = bitcoin.address.fromBech32(address);
        return addressDetails.prefix === this.network.bech32;
      } catch (e) {
        return false;
      }
    }

    // the address version needs to be among the valid ones
    return validVersions.includes(addressDetails.version);
  }

  /**
   * Return boolean indicating whether input is valid public key for the coin.
   *
   * @param {String} pub the pub to be checked
   * @returns {Boolean} is it valid?
   */
  isValidPub(pub) {
    try {
      bitcoin.HDNode.fromBase58(pub);
      return true;
    } catch (e) {
      return false;
    }
  }

  postProcessPrebuild(prebuild, callback) {
    return co(function *() {
      if (prebuild._reqId) {
        this.bitgo._reqId = prebuild._reqId;
      }
      const chainhead = yield this.bitgo.get(this.url('/public/block/latest')).result();
      const blockHeight = chainhead.height;
      const transaction = bitcoin.Transaction.fromHex(prebuild.txHex, this.network);
      transaction.locktime = blockHeight + 1;
      return _.extend({}, prebuild, { txHex: transaction.toHex() });
    }).call(this).asCallback(callback);
  }

  /**
   * Find outputs that are within expected outputs but not within actual outputs, including duplicates
   * @param expectedOutputs
   * @param actualOutputs
   * @returns {Array}
   */
  static findMissingOutputs(expectedOutputs, actualOutputs) {
    const keyFunc = ({ address, amount }) => `${address}:${Number(amount)}`;
    const groupedOutputs = _.groupBy(expectedOutputs, keyFunc);

    actualOutputs.forEach((output) => {
      const group = groupedOutputs[keyFunc(output)];
      if (group) {
        group.pop();
      }
    });

    return _.flatten(_.values(groupedOutputs));
  }

  /**
   * Determine an address' type based on its witness and redeem script presence
   * @param addressDetails
   */
  static inferAddressType(addressDetails) {
    if (_.isObject(addressDetails.coinSpecific)) {
      if (_.isString(addressDetails.coinSpecific.redeemScript) && _.isString(addressDetails.coinSpecific.witnessScript)) {
        return this.AddressTypes.P2SH_P2WSH;
      } else if (_.isString(addressDetails.coinSpecific.redeemScript)) {
        return this.AddressTypes.P2SH;
      } else if (_.isString(addressDetails.coinSpecific.witnessScript)) {
        return this.AddressTypes.P2WSH;
      }
    }
    return null;
  }

  /**
   * Extract and fill transaction details such as internal/change spend, external spend (explicit vs. implicit), etc.
   * @param txParams
   * @param txPrebuild
   * @param wallet
   * @param verification
   * @param callback
   * @returns {*}
   */
  parseTransaction({ txParams, txPrebuild, wallet, verification = {}, reqId }, callback) {
    return co(function *() {
      if (!_.isUndefined(verification.disableNetworking) && !_.isBoolean(verification.disableNetworking)) {
        throw new Error('verification.disableNetworking must be a boolean');
      }
      const disableNetworking = !!verification.disableNetworking;

      // obtain the keychains and key signatures
      let keychains = verification.keychains;
      if (!keychains && disableNetworking) {
        throw new Error('cannot fetch keychains without networking');
      } else if (!keychains) {
        keychains = yield Promise.props({
          user: this.keychains().get({ id: wallet._wallet.keys[0], reqId }),
          backup: this.keychains().get({ id: wallet._wallet.keys[1], reqId }),
          bitgo: this.keychains().get({ id: wallet._wallet.keys[2], reqId })
        });
      }
      const keychainArray = [keychains.user, keychains.backup, keychains.bitgo];

      const keySignatures = _.get(wallet, '_wallet.keySignatures');

      // obtain all outputs
      const explanation = this.explainTransaction({
        txHex: txPrebuild.txHex,
        txInfo: txPrebuild.txInfo,
        keychains: keychains
      });

      const allOutputs = [...explanation.outputs, ...explanation.changeOutputs];

      // verify that each recipient from txParams has their own output
      const expectedOutputs = _.get(txParams, 'recipients', []);
      const missingOutputs = this.constructor.findMissingOutputs(expectedOutputs, allOutputs);

      /**
       * Loop through all the outputs and classify each of them as either internal spends
       * or external spends by setting the "external" property to true or false on the output object.
       */
      const allOutputDetails = yield Promise.map(allOutputs, co(function *(currentOutput) {
        const currentAddress = currentOutput.address;

        // attempt to grab the address details from either the prebuilt tx, or the verification params.
        // If both of these are empty, then we will try to get the address details from bitgo instead
        const addressDetailsPrebuild = _.get(txPrebuild, `txInfo.walletAddressDetails.${currentAddress}`, {});
        const addressDetailsVerification = _.get(verification, `addresses.${currentAddress}`, {});
        debug('Parsing address details for %s', currentAddress);
        try {
          /**
           * The only way to determine whether an address is known on the wallet is to initiate a network request and
           * fetch it. Should the request fail and return a 404, it will throw and therefore has to be caught. For that
           * reason, address wallet ownership detection is wrapped in a try/catch. Additionally, once the address
           * details are fetched on the wallet, a local address validation is run, whose errors however are generated
           * client-side and can therefore be analyzed with more granularity and type checking.
           */
          let addressDetails = _.extend({}, addressDetailsPrebuild, addressDetailsVerification);
          debug('Locally available address %s details: %O', currentAddress, addressDetails);
          if (_.isEmpty(addressDetails) && !disableNetworking) {
            addressDetails = yield wallet.getAddress({ address: currentAddress, reqId });
            debug('Downloaded address %s details: %O', currentAddress, addressDetails);
          }
          // verify that the address is on the wallet. verifyAddress throws if
          // it fails to correctly rederive the address, meaning it's external
          const addressType = this.constructor.inferAddressType(addressDetails);
          this.verifyAddress(_.extend({ addressType }, addressDetails, {
            keychains: keychainArray,
            address: currentAddress
          }));
          debug('Address %s verification passed', currentAddress);

          // verify address succeeded without throwing, so the address was
          // correctly rederived from the wallet keychains, making it not external
          return _.extend({}, currentOutput, addressDetails, { external: false });
        } catch (e) {
          // verify address threw an exception
          debug('Address %s verification threw an error:', currentAddress, e);
          // Todo: name server-side errors to avoid message-based checking [BG-5124]
          const walletAddressNotFound = e.message.includes('wallet address not found');
          const unexpectedAddress = (e instanceof errors.UnexpectedAddressError);
          if (walletAddressNotFound || unexpectedAddress) {
            if (unexpectedAddress && !walletAddressNotFound) {
              /**
               * this could be a migrated SafeHD BCH wallet, and the transaction we are currently
               * parsing is trying to spend change back to the v1 wallet base address.
               * It does this since we don't allow new address creation for these wallets,
               * and instead return the base address from the v1 wallet when a new address is requested.
               * If this new address is requested for the purposes of spending change back to the wallet,
               * the change will go to the v1 wallet base address. This address *is* on the wallet,
               * but it will still cause an error to be thrown by verifyAddress, since the derivation path
               * used for this address is non-standard. (I have seen these addresses derived using paths m/0/0 and m/101,
               * whereas the v2 addresses are derived using path  m/0/0/${chain}/${index}).
               *
               * This means we need to check for this case explicitly in this catch block, and classify
               * these types of outputs as internal instead of external. Failing to do so would cause the
               * transaction's implicit external outputs (ie, outputs which go to addresses not specified in
               * the recipients array) to add up to more than the 150 basis point limit which we enforce on
               * pay-as-you-go outputs (which should be the only implicit external outputs on our transactions).
               *
               * The 150 basis point limit for implicit external sends is enforced in verifyTransaction,
               * which calls this function to get information on the total external/internal spend amounts
               * for a transaction. The idea here is to protect from the transaction being maliciously modified
               * to add more implicit external spends (eg, to an attacker-controlled wallet).
               *
               * See verifyTransaction for more information on how transaction prebuilds are verified before signing.
               */

              if (_.isString(wallet._wallet.migratedFrom) && wallet._wallet.migratedFrom === currentAddress) {
                debug('found address %s which was migrated from v1 wallet, address is not external', currentAddress);
                return _.extend({}, currentOutput, { external: false });
              }

              debug('Address %s was found on wallet but could not be reconstructed', currentAddress);
            }

            // the address was found, but not on the wallet, which simply means it's external
            debug('Address %s presumed external', currentAddress);
            return _.extend({}, currentOutput, { external: true });
          } else if (e instanceof errors.InvalidAddressDerivationPropertyError && currentAddress === txParams.changeAddress) {
            // expect to see this error when passing in a custom changeAddress with no chain or index
            return _.extend({}, currentOutput, { external: false });
          }

          debug('Address %s verification failed', currentAddress);
          /**
           * It might be a completely invalid address or a bad validation attempt or something else completely, in
           * which case we do not proceed and rather rethrow the error, which is safer than assuming that the address
           * validation failed simply because it's external to the wallet.
           */
          throw e;
        }
      }).bind(this));

      const changeOutputs = _.filter(allOutputDetails, { external: false });

      // these are all the outputs that were not originally explicitly specified in recipients
      const implicitOutputs = this.constructor.findMissingOutputs(allOutputDetails, expectedOutputs);

      const explicitOutputs = this.constructor.findMissingOutputs(allOutputDetails, implicitOutputs);

      // these are all the non-wallet outputs that had been originally explicitly specified in recipients
      const explicitExternalOutputs = _.filter(explicitOutputs, { external: true });

      // this is the sum of all the originally explicitly specified non-wallet output values
      const explicitExternalSpendAmount = _.sumBy(explicitExternalOutputs, 'amount');

      /**
       * The calculation of the implicit external spend amount pertains to verifying the pay-as-you-go-fee BitGo
       * automatically applies to transactions sending money out of the wallet. The logic is fairly straightforward
       * in that we compare the external spend amount that was specified explicitly by the user to the portion
       * that was specified implicitly. To protect customers from people tampering with the transaction outputs, we
       * define a threshold for the maximum percentage of the implicit external spend in relation to the explicit
       * external spend.
       */

      // make sure that all the extra addresses are change addresses
      // get all the additional external outputs the server added and calculate their values
      const implicitExternalOutputs = _.filter(implicitOutputs, { external: true });
      const implicitExternalSpendAmount = _.sumBy(implicitExternalOutputs, 'amount');

      return {
        keychains,
        keySignatures,
        outputs: allOutputDetails,
        missingOutputs,
        explicitExternalOutputs,
        implicitExternalOutputs,
        changeOutputs,
        explicitExternalSpendAmount,
        implicitExternalSpendAmount
      };

    }).call(this).asCallback(callback);
  }

  /**
   * Verify that a transaction prebuild complies with the original intention
   * @param txParams params object passed to send
   * @param txPrebuild prebuild object returned by server
   * @param txPrebuild.txHex prebuilt transaction's txHex form
   * @param wallet Wallet object to obtain keys to verify against
   * @param verification Object specifying some verification parameters
   * @param verification.disableNetworking Disallow fetching any data from the internet for verification purposes
   * @param verification.keychains Pass keychains manually rather than fetching them by id
   * @param verification.addresses Address details to pass in for out-of-band verification
   * @param callback
   * @returns {boolean}
   */
  verifyTransaction({ txParams, txPrebuild, wallet, verification = {}, reqId }, callback) {
    return co(function *() {
      const disableNetworking = !!verification.disableNetworking;
      const parsedTransaction = yield this.parseTransaction({ txParams, txPrebuild, wallet, verification, reqId });

      const keychains = parsedTransaction.keychains;

      // let's verify these keychains
      const keySignatures = parsedTransaction.keySignatures;
      if (!_.isEmpty(keySignatures)) {
        // first, let's verify the integrity of the user key, whose public key is used for subsequent verifications
        const userPub = keychains.user.pub;
        const userKey = bitcoin.HDNode.fromBase58(userPub);
        let userPrv = keychains.user.prv;
        if (_.isEmpty(userPrv)) {
          const encryptedPrv = keychains.user.encryptedPrv;
          if (!_.isEmpty(encryptedPrv)) {
            // if the decryption fails, it will throw an error
            userPrv = this.bitgo.decrypt({
              input: encryptedPrv,
              password: txParams.walletPassphrase
            });
          }
        }
        if (_.isEmpty(userPrv)) {
          const errorMessage = 'user private key unavailable for verification';
          if (disableNetworking) {
            console.log(errorMessage);
          } else {
            throw new Error(errorMessage);
          }
        } else {
          const userPrivateKey = bitcoin.HDNode.fromBase58(userPrv);
          if (userPrivateKey.toBase58() === userPrivateKey.neutered().toBase58()) {
            throw new Error('user private key is only public');
          }
          if (userPrivateKey.neutered().toBase58() !== userPub) {
            throw new Error('user private key does not match public key');
          }
        }

        const backupPubSignature = keySignatures.backupPub;
        const bitgoPubSignature = keySignatures.bitgoPub;

        // verify the signatures against the user public key
        const signingAddress = userKey.keyPair.getAddress();

        // BG-5703: use BTC mainnet prefix for all key signature operations
        // (this means do not pass a prefix parameter, and let it use the default prefix instead)
        const isValidBackupSignature = bitcoinMessage.verify(keychains.backup.pub, signingAddress, Buffer.from(backupPubSignature, 'hex'));
        const isValidBitgoSignature = bitcoinMessage.verify(keychains.bitgo.pub, signingAddress, Buffer.from(bitgoPubSignature, 'hex'));

        if (!isValidBackupSignature || !isValidBitgoSignature) {
          throw new Error('secondary public key signatures invalid');
        }
      } else if (!disableNetworking) {
        // these keys were obtained online and their signatures were not verified
        // this could be dangerous
        console.log('unsigned keys obtained online are being used for address verification');
      }

      const missingOutputs = parsedTransaction.missingOutputs;
      if (missingOutputs.length !== 0) {
        // there are some outputs in the recipients list that have not made it into the actual transaction
        throw new Error('expected outputs missing in transaction prebuild');
      }

      const intendedExternalSpend = parsedTransaction.explicitExternalSpendAmount;

      // this is a limit we impose for the total value that is amended to the transaction beyond what was originally intended
      const payAsYouGoLimit = intendedExternalSpend * 0.015; // 150 basis points is the absolute permitted maximum

      /*
      Some explanation for why we're doing what we're doing:
      Some customers will have an output to BitGo's PAYGo wallet added to their transaction, and we need to account for
      it here. To protect someone tampering with the output to make it send more than it should to BitGo, we define a
      threshold for the output's value above which we'll throw an error, because the paygo output should never be that
      high.
       */

      // make sure that all the extra addresses are change addresses
      // get all the additional external outputs the server added and calculate their values
      const nonChangeAmount = parsedTransaction.implicitExternalSpendAmount;

      // the additional external outputs can only be BitGo's pay-as-you-go fee, but we cannot verify the wallet address
      if (nonChangeAmount > payAsYouGoLimit) {
        // there are some addresses that are outside the scope of intended recipients that are not change addresses
        throw new Error('prebuild attempts to spend to unintended external recipients');
      }

      const allOutputs = parsedTransaction.outputs;
      const transaction = bitcoin.Transaction.fromHex(txPrebuild.txHex, this.network);
      const transactionCache = {};
      const inputs = yield Promise.map(transaction.ins, co(function *(currentInput) {
        const transactionId = Buffer.from(currentInput.hash).reverse().toString('hex');
        const txHex = _.get(txPrebuild, `txInfo.txHexes.${transactionId}`);
        if (txHex) {
          const localTx = bitcoin.Transaction.fromHex(txHex, this.network);
          if (localTx.getId() !== transactionId) {
            throw new Error('input transaction hex does not match id');
          }
          const currentOutput = localTx.outs[currentInput.index];
          const address = bitcoin.address.fromOutputScript(currentOutput.script, this.network);
          return {
            address,
            value: currentOutput.value
          };
        } else if (!transactionCache[transactionId]) {
          if (disableNetworking) {
            throw new Error('attempting to retrieve transaction details externally with networking disabled');
          }
          if (reqId) {
            this.bitgo._reqId = reqId;
          }
          transactionCache[transactionId] = yield this.bitgo.get(this.url(`/public/tx/${transactionId}`)).result();
        }
        const transactionDetails = transactionCache[transactionId];
        return transactionDetails.outputs[currentInput.index];
      }).bind(this));

      const inputAmount = _.sumBy(inputs, 'value');
      const outputAmount = _.sumBy(allOutputs, 'amount');
      const fee = inputAmount - outputAmount;

      if (fee < 0) {
        throw new Error(`attempting to spend ${outputAmount} satoshis, which exceeds the input amount (${inputAmount} satoshis) by ${-fee}`);
      }

      return true;
    }).call(this).asCallback(callback);
  }

  /**
   * Make sure an address is valid and throw an error if it's not.
   * @param address The address string on the network
   * @param addressType
   * @param keychains Keychain objects with xpubs
   * @param coinSpecific Coin-specific details for the address such as a witness script
   * @param chain Derivation chain
   * @param index Derivation index
   */
  verifyAddress({ address, addressType, keychains, coinSpecific, chain, index }) {
    if (!this.isValidAddress(address)) {
      throw new errors.InvalidAddressError(`invalid address: ${address}`);
    }

    if ((_.isUndefined(chain) && _.isUndefined(index)) || (!(_.isFinite(chain) && _.isFinite(index)))) {
      throw new errors.InvalidAddressDerivationPropertyError(`address validation failure: invalid chain (${chain}) or index (${index})`);
    }

    if (!_.isObject(coinSpecific)) {
      throw new errors.InvalidAddressVerificationObjectPropertyError('address validation failure: coinSpecific field must be an object');
    }


    const expectedAddress = this.generateAddress({
      addressType,
      keychains,
      threshold: 2,
      chain: chain,
      index: index
    });

    if (expectedAddress.address !== address) {
      throw new errors.UnexpectedAddressError(`address validation failure: expected ${expectedAddress.address} but got ${address}`);
    }
  }

  /**
   * Indicates whether coin supports a block target
   * @returns {boolean}
   */
  supportsBlockTarget() {
    return true;
  }

  /**
   * Indicates whether a coin supports pay-to-witness script hash addresses
   * @returns {boolean}
   */
  supportsP2wsh() {
    return false;
  }

  /**
   * Generate an address for a wallet based on a set of configurations
   * @param addressType
   * @param keychains Array of objects with xpubs
   * @param threshold Minimum number of signatures
   * @param chain Derivation chain
   * @param index Derivation index
   * @param segwit
   * @param bech32
   * @returns {{chain: number, index: number, coin: number, coinSpecific: {outputScript, redeemScript}}}
   */
  generateAddress({ addressType, keychains, threshold, chain, index, segwit, bech32 }) {
    if (addressType === this.constructor.AddressTypes.P2WSH && !this.supportsP2wsh()) {
      throw new errors.P2wshUnsupportedError();
    }

    if (!_.isUndefined(addressType) && !this.constructor.validAddressTypes.includes(addressType)) {
      throw new errors.UnsupportedAddressTypeError();
    } else if (_.isUndefined(addressType)) {
      addressType = this.constructor.AddressTypes.P2SH;
      if (_.isBoolean(segwit) && segwit) {
        addressType = this.constructor.AddressTypes.P2SH_P2WSH;
      }
      if (_.isBoolean(bech32) && bech32) {
        addressType = this.constructor.AddressTypes.P2WSH;
      }
    }

    let signatureThreshold = 2;
    if (_.isInteger(threshold)) {
      signatureThreshold = threshold;
      if (signatureThreshold <= 0) {
        throw new Error('threshold has to be positive');
      }
      if (signatureThreshold > keychains.length) {
        throw new Error('threshold cannot exceed number of keys');
      }
    }

    let derivationChain = 0;
    if (_.isInteger(chain) && chain > 0) {
      derivationChain = chain;
    }

    let derivationIndex = 0;
    if (_.isInteger(index) && index > 0) {
      derivationIndex = index;
    }

    const path = 'm/0/0/' + derivationChain + '/' + derivationIndex;
    const hdNodes = keychains.map(({ pub }) => prova.HDNode.fromBase58(pub));
    const derivedKeys = hdNodes.map(hdNode => hdNode.hdPath().deriveKey(path).getPublicKeyBuffer());

    const inputScript = bitcoin.script.multisig.output.encode(signatureThreshold, derivedKeys);
    const inputScriptHash = bitcoin.crypto.hash160(inputScript);
    let outputScript = bitcoin.script.scriptHash.output.encode(inputScriptHash);

    const addressDetails = {
      chain: derivationChain,
      index: derivationIndex,
      coin: this.getChain(),
      coinSpecific: {},
      addressType
    };

    addressDetails.coinSpecific.redeemScript = inputScript.toString('hex');

    if (['p2sh-p2wsh', 'p2wsh'].includes(addressType)) {
      const witnessScriptHash = bitcoin.crypto.sha256(inputScript);
      const redeemScript = bitcoin.script.witnessScriptHash.output.encode(witnessScriptHash);
      const redeemScriptHash = bitcoin.crypto.hash160(redeemScript);
      outputScript = bitcoin.script.scriptHash.output.encode(redeemScriptHash);
      addressDetails.coinSpecific.witnessScript = inputScript.toString('hex');
      addressDetails.coinSpecific.redeemScript = redeemScript.toString('hex');
      if (addressType === 'p2wsh') {
        outputScript = redeemScript;
        delete addressDetails.coinSpecific.redeemScript;
      }
    }

    addressDetails.coinSpecific.outputScript = outputScript.toString('hex');
    addressDetails.address = this.getCoinLibrary().address.fromOutputScript(outputScript, this.network);

    return addressDetails;
  }

  /**
   * Assemble keychain and half-sign prebuilt transaction
   * @param params
   * - txPrebuild
   * - prv
   * @param params.isLastSignature Ture if txb.build() should be called and not buildIncomplete()
   * @returns {{txHex}}
   */
  signTransaction(params) {
    const txPrebuild = params.txPrebuild;
    const userPrv = params.prv;

    if (_.isUndefined(txPrebuild) || !_.isObject(txPrebuild)) {
      if (!_.isUndefined(txPrebuild) && !_.isObject(txPrebuild)) {
        throw new Error(`txPrebuild must be an object, got type ${typeof txPrebuild}`);
      }
      throw new Error('missing txPrebuild parameter');
    }
    let transaction = bitcoin.Transaction.fromHex(txPrebuild.txHex, this.network);

    if (transaction.ins.length !== txPrebuild.txInfo.unspents.length) {
      throw new Error('length of unspents array should equal to the number of transaction inputs');
    }

    let isLastSignature = false;
    if (_.isBoolean(params.isLastSignature)) {
      // if build is called instead of buildIncomplete, no signature placeholders are left in the sig script
      isLastSignature = params.isLastSignature;
    }

    if (_.isUndefined(userPrv) || !_.isString(userPrv)) {
      if (!_.isUndefined(userPrv) && !_.isString(userPrv)) {
        throw new Error(`prv must be a string, got type ${typeof userPrv}`);
      }
      throw new Error('missing prv parameter to sign transaction');
    }

    const keychain = bitcoin.HDNode.fromBase58(userPrv);
    const hdPath = bitcoin.hdPath(keychain);
    const txb = bitcoin.TransactionBuilder.fromTransaction(transaction, this.network);
    this.constructor.prepareTransactionBuilder(txb);

    const signatureIssues = [];
    const bech32Indices = [];

    for (let index = 0; index < transaction.ins.length; ++index) {
      debug('Signing input %d of %d', index + 1, transaction.ins.length);
      const currentUnspent = txPrebuild.txInfo.unspents[index];
      if (this.isBitGoTaintedUnspent(currentUnspent)) {
        debug('Skipping input %d of %d (unspent from replay protection address which is platform signed only)', index + 1, transaction.ins.length);
        continue;
      }
      const path = 'm/0/0/' + currentUnspent.chain + '/' + currentUnspent.index;
      const privKey = hdPath.deriveKey(path);
      privKey.network = this.network;

      const currentSignatureIssue = {
        inputIndex: index,
        unspent: currentUnspent,
        path: path
      };
      debug('Input details: %O', currentSignatureIssue);


      const isBech32 = !currentUnspent.redeemScript;
      const isSegwit = !!currentUnspent.witnessScript;
      const sigHashType = this.constructor.defaultSigHashType;
      try {
        if (isBech32) {
          const witnessScript = Buffer.from(currentUnspent.witnessScript, 'hex');
          const witnessScriptHash = bitcoin.crypto.sha256(witnessScript);
          const prevOutScript = bitcoin.script.witnessScriptHash.output.encode(witnessScriptHash);
          txb.sign(index, privKey, prevOutScript, sigHashType, currentUnspent.value, witnessScript);
        } else {
          const subscript = new Buffer(currentUnspent.redeemScript, 'hex');
          if (isSegwit) {
            debug('Signing segwit input');
            const witnessScript = Buffer.from(currentUnspent.witnessScript, 'hex');
            txb.sign(index, privKey, subscript, sigHashType, currentUnspent.value, witnessScript);
          } else {
            debug('Signing p2sh input');
            txb.sign(index, privKey, subscript, sigHashType, currentUnspent.value);
          }
        }

      } catch (e) {
        debug('Failed to sign input:', e);
        currentSignatureIssue.error = e;
        signatureIssues.push(currentSignatureIssue);
        continue;
      }

      if (isLastSignature) {
        transaction = txb.build();
      } else {
        transaction = txb.buildIncomplete();
      }

      // after signature validation, prepare bech32 setup
      if (isBech32) {
        transaction.setInputScript(index, Buffer.alloc(0));
        bech32Indices.push(index);
      }

      const isValidSignature = this.verifySignature(transaction, index, currentUnspent.value);
      if (!isValidSignature) {
        debug('Invalid signature');
        currentSignatureIssue.error = new Error('invalid signature');
        signatureIssues.push(currentSignatureIssue);
      }
    }

    if (signatureIssues.length > 0) {
      const failedIndices = signatureIssues.map(currentIssue => currentIssue.inputIndex);
      const error = new Error(`Failed to sign inputs at indices ${failedIndices.join(', ')}`);
      error.code = 'input_signature_failure';
      error.signingErrors = signatureIssues;
      throw error;
    }

    for (const bech32Index of bech32Indices) {
      transaction.setInputScript(bech32Index, Buffer.alloc(0));
    }

    return {
      txHex: transaction.toBuffer().toString('hex')
    };
  }

  /**
   * Always false for coins other than BCH and TBCH.
   * @param unspent
   * @returns {boolean}
   */
  isBitGoTaintedUnspent(unspent) {
    return false;
  }

  /**
   * Modify the transaction builder to comply with the specific coin's requirements such as version and branch id
   * @param txBuilder
   * @returns {*}
   */
  static prepareTransactionBuilder(txBuilder) {
    return txBuilder;
  }

  /**
   *
   * @returns {number}
   */
  static get defaultSigHashType() {
    return bitcoin.Transaction.SIGHASH_ALL;
  }

  /**
   * Parse a transaction's signature script to obtain public keys, signatures, the sig script, and other properties
   * @param transaction
   * @param inputIndex
   * @returns {boolean}
   */
  parseSignatureScript(transaction, inputIndex) {
    const currentInput = transaction.ins[inputIndex];
    let signatureScript = currentInput.script;
    let decompiledSigScript = bitcoin.script.decompile(signatureScript);

    const isSegwitInput = currentInput.witness.length > 0;
    const isBech32Input = isSegwitInput && (signatureScript.length === 0);
    if (isSegwitInput) {
      decompiledSigScript = currentInput.witness;
      signatureScript = bitcoin.script.compile(decompiledSigScript);
      if (isBech32Input) {
        const lastWitness = _.last(transaction.ins[inputIndex].witness);
        // const inputScriptHash = bitcoin.crypto.hash160(lastWitness);
        const witnessScriptHash = bitcoin.crypto.sha256(lastWitness);
        const prevOutScript = bitcoin.script.witnessScriptHash.output.encode(witnessScriptHash);
        // we are faking a signature script for the verification
        signatureScript = bitcoin.script.compile([prevOutScript]);
      }
    }

    const inputClassification = bitcoin.script.classifyInput(signatureScript, true);
    if (inputClassification !== bitcoin.script.types.P2SH) {
      if (inputClassification === bitcoin.script.types.P2PKH) {
        const [signature, publicKey] = decompiledSigScript;
        const publicKeys = [publicKey];
        const signatures = [signature];

        const pubScript = bitcoin.script.pubKeyHash.output.encode(bitcoin.crypto.hash160(publicKey));
        return { signatures, publicKeys, isSegwitInput, inputClassification, pubScript: pubScript };
      }
      return { isSegwitInput, inputClassification };
    }

    // all but the last entry
    const signatures = decompiledSigScript.slice(0, -1);
    // the last entry
    const pubScript = _.last(decompiledSigScript);
    const decompiledPubScript = bitcoin.script.decompile(pubScript);
    // the second through antepenultimate entries
    const publicKeys = decompiledPubScript.slice(1, -2);

    return { signatures, publicKeys, isSegwitInput, inputClassification, pubScript };
  }

  /**
   * Calculate the hash to verify the signature against
   * @param transaction Transaction object
   * @param inputIndex
   * @param pubScript
   * @param amount The previous output's amount
   * @param hashType
   * @param isSegwitInput
   * @returns {*}
   */
  calculateSignatureHash(transaction, inputIndex, pubScript, amount, hashType, isSegwitInput) {
    if (isSegwitInput) {
      return transaction.hashForWitnessV0(inputIndex, pubScript, amount, hashType);
    } else {
      return transaction.hashForSignature(inputIndex, pubScript, hashType);
    }
  }

  /**
   * Verify the signature on a (half-signed) transaction
   * @param transaction bitcoinjs-lib tx object
   * @param inputIndex The input whererfore to check the signature
   * @param amount For segwit and BCH, the input amount needs to be known for signature verification
   * @param verificationSettings
   * @param verificationSettings.signatureIndex The index of the signature to verify (only iterates over non-empty signatures)
   * @param verificationSettings.publicKey The hex of the public key to verify (will verify all signatures)
   * @returns {boolean}
   */
  verifySignature(transaction, inputIndex, amount, verificationSettings = {}) {

    const { signatures, publicKeys, isSegwitInput, inputClassification, pubScript } = this.parseSignatureScript(transaction, inputIndex);

    if (![bitcoin.script.types.P2SH, bitcoin.script.types.P2PKH].includes(inputClassification)) {
      return false;
    }

    if (isSegwitInput && !amount) {
      return false;
    }

    // get the first non-empty signature and verify it against all public keys
    const nonEmptySignatures = _.filter(signatures, s => !_.isEmpty(s));

    /*
    We either want to verify all signature/pubkey combinations, or do an explicit combination

    If a signature index is specified, only that signature is checked. It's verified against all public keys.
    If a single public key is found to be valid, the function returns true.

    If a public key is specified, we iterate over all signatures. If a single one matches the public key, the function
    returns true.

    If neither is specified, all signatures are checked against all public keys. Each signature must have its own distinct
    public key that it matches for the function to return true.
     */
    let signaturesToCheck = nonEmptySignatures;
    if (!_.isUndefined(verificationSettings.signatureIndex)) {
      signaturesToCheck = [nonEmptySignatures[verificationSettings.signatureIndex]];
    }

    const publicKeyHex = verificationSettings.publicKey;
    const matchedPublicKeyIndices = {};
    let areAllSignaturesValid = true;

    // go over all signatures
    for (const signatureBuffer of signaturesToCheck) {

      let isSignatureValid = false;

      if (Buffer.isBuffer(signatureBuffer) && signatureBuffer.length > 0) {
        // slice the last byte from the signature hash input because it's the hash type
        const signature = bitcoin.ECSignature.fromDER(signatureBuffer.slice(0, -1));
        const hashType = _.last(signatureBuffer);
        const signatureHash = this.calculateSignatureHash(transaction, inputIndex, pubScript, amount, hashType, isSegwitInput);

        for (let publicKeyIndex = 0; publicKeyIndex < publicKeys.length; publicKeyIndex++) {

          const publicKeyBuffer = publicKeys[publicKeyIndex];
          if (!_.isUndefined(publicKeyHex) && publicKeyBuffer.toString('hex') !== publicKeyHex) {
            // we are only looking to verify one specific public key's signature (publicKeyHex)
            // this particular public key is not the one whose signature we're trying to verify
            continue;
          }

          if (matchedPublicKeyIndices[publicKeyIndex]) {
            continue;
          }

          const publicKey = bitcoin.ECPair.fromPublicKeyBuffer(publicKeyBuffer);
          if (publicKey.verify(signatureHash, signature)) {
            isSignatureValid = true;
            matchedPublicKeyIndices[publicKeyIndex] = true;
            break;
          }
        }
      }

      if (!_.isUndefined(publicKeyHex) && isSignatureValid) {
        // We were trying to see if any of the signatures was valid for the given public key. Evidently yes.
        return true;
      }

      if (!isSignatureValid && _.isUndefined(publicKeyHex)) {
        return false;
      }

      areAllSignaturesValid = isSignatureValid && areAllSignaturesValid;
    }

    return areAllSignaturesValid;
  }

  explainTransaction(params) {
    const self = this;
    const transaction = bitcoin.Transaction.fromBuffer(new Buffer(params.txHex, 'hex'), this.network);
    const id = transaction.getId();
    let changeAddresses = [];
    let spendAmount = 0;
    let changeAmount = 0;
    if (params.txInfo && params.txInfo.changeAddresses) {
      changeAddresses = params.txInfo.changeAddresses;
    }
    const explanation = {
      displayOrder: ['id', 'outputAmount', 'changeAmount', 'outputs', 'changeOutputs'],
      id: id,
      outputs: [],
      changeOutputs: []
    };
    transaction.outs.forEach(function(currentOutput) {
      const currentAddress = self.getCoinLibrary().address.fromOutputScript(currentOutput.script, self.network);
      const currentAmount = currentOutput.value;

      if (changeAddresses.indexOf(currentAddress) !== -1) {
        // this is change
        changeAmount += currentAmount;
        explanation.changeOutputs.push({
          address: currentAddress,
          amount: currentAmount
        });
        return;
      }

      spendAmount += currentAmount;
      explanation.outputs.push({
        address: currentAddress,
        amount: currentAmount
      });
    });
    explanation.outputAmount = spendAmount;
    explanation.changeAmount = changeAmount;

    // add fee info if available
    if (params.feeInfo) {
      explanation.displayOrder.push('fee');
      explanation.fee = params.feeInfo;
    }

    if (_.isInteger(transaction.locktime) && transaction.locktime > 0) {
      explanation.locktime = transaction.locktime;
      explanation.displayOrder.push('locktime');
    }
    return explanation;
  }

  calculateRecoveryAddress(scriptHashScript) {
    return this.getCoinLibrary().address.fromOutputScript(scriptHashScript, this.network);
  }

  getRecoveryFeePerBytes() {
    return Promise.resolve(100);
  }

  getRecoveryFeeRecommendationApiBaseUrl() {
    return Promise.reject(new Error('AbtractUtxoCoin method not implemented'));
  }

  getRecoveryMarketPrice() {
    return co(function *getRecoveryMarketPrice() {
      const bitcoinAverageUrl = config.bitcoinAverageBaseUrl + this.getFamily().toUpperCase() + 'USD';
      const response = yield request.get(bitcoinAverageUrl).retry(2).result();

      if (response === null || typeof response.last !== 'number') {
        throw new Error('unable to reach BitcoinAverage for price data');
      }

      return response.last;
    }).call(this);
  }


  /**
   * Helper function for recover()
   * This transforms the txInfo from recover into the format that offline-signing-tool expects
   * @param txInfo
   * @param txHex
   * @returns {{txHex: *, txInfo: {unspents: *}, feeInfo: {}, coin: void}}
   */
  formatForOfflineVault(txInfo, txHex) {
    const response = {
      txHex,
      txInfo: {
        unspents: txInfo.inputs
      },
      feeInfo: {},
      coin: this.getChain()
    };
    _.map(response.txInfo.unspents, function(unspent) {
      const pathArray = unspent.chainPath.split('/');
      // Note this code works because we assume our chainPath is m/0/0/chain/index - this will be incorrect for custom derivation schemes
      unspent.index = pathArray[4];
      unspent.chain = pathArray[3];
    });
    return response;
  }

  /**
   * Builds a funds recovery transaction without BitGo
   * @param params
   * - userKey: [encrypted] xprv, or xpub
   * - backupKey: [encrypted] xprv, or xpub if the xprv is held by a KRS provider
   * - walletPassphrase: necessary if one of the xprvs is encrypted
   * - bitgoKey: xpub
   * - krsProvider: necessary if backup key is held by KRS
   * - recoveryDestination: target address to send recovered funds to
   * - scan: the amount of consecutive addresses without unspents to scan through before stopping
   * - ignoreAddressTypes: (optional) array of AddressTypes to ignore. these are strings defined in AbstractUtxoCoin.AddressTypes
   *        for example: ['p2sh-p2wsh', 'p2wsh'] will prevent code from checking for wrapped-segwit and native-segwit chains on the public block explorers
   * @param callback
   */
  recover(params, callback) {
    return co(function *recover() {
      const self = this;

      // ============================HELPER FUNCTIONS============================
      function deriveKeys(keyArray, index) {
        return keyArray.map((k) => k.derive(index));
      }

      const queryBlockchainUnspentsPath = co(function *queryBlockchainUnspentsPath(keyArray, basePath) {
        const MAX_SEQUENTIAL_ADDRESSES_WITHOUT_TXS = params.scan || 20;
        let numSequentialAddressesWithoutTxs = 0;

        // get unspents for these addresses
        const gatherUnspents = co(function *coGatherUnspents(addrIndex) {
          const derivedKeys = deriveKeys(keyArray, addrIndex);
          const chain = basePath.split('/').pop(); // extracts the chain from the basePath
          const address = createMultiSigAddress(derivedKeys, chain);
          const addressBase58 = address.address;

          const addrInfo = yield self.getAddressInfoFromExplorer(addressBase58);

          if (addrInfo.txCount === 0) {
            numSequentialAddressesWithoutTxs++;
          } else {
            numSequentialAddressesWithoutTxs = 0;

            if (addrInfo.totalBalance > 0) {
              // this wallet has a balance
              address.chainPath = basePath + '/' + addrIndex;
              address.userKey = derivedKeys[0];
              address.backupKey = derivedKeys[1];
              addressesById[addressBase58] = address;

              // try to find unspents on the address
              const addressUnspents = yield self.getUnspentInfoFromExplorer(addressBase58);

              addressUnspents.forEach(function addAddressToUnspent(unspent) {
                unspent.address = address.address;
                walletUnspents.push(unspent);
              });
            }
          }

          if (numSequentialAddressesWithoutTxs >= MAX_SEQUENTIAL_ADDRESSES_WITHOUT_TXS) {
            // stop searching for addresses with unspents in them, we've found 5 in a row with none
            // we are done
            return;
          }

          return gatherUnspents(addrIndex + 1);
        });

        const walletUnspents = [];
        // This will populate walletAddresses
        yield gatherUnspents(0);

        if (walletUnspents.length === 0) {
          // Couldn't find any addresses with funds
          return [];
        }

        return walletUnspents;
      });

      function createMultiSigAddress(keyArray, chain) {
        const publicKeys = keyArray.map((k) => k.getPublicKeyBuffer());
        const isSegwit = (chain === '10' || chain === '11');
        const multisigProgram = bitcoin.script.multisig.output.encode(2, publicKeys);
        let redeemScript, witnessScript;
        if (isSegwit) {
          witnessScript = multisigProgram;
          redeemScript = bitcoin.script.witnessScriptHash.output.encode(bitcoin.crypto.sha256(witnessScript));
        } else {
          redeemScript = multisigProgram;
        }
        const redeemScriptHash = bitcoin.crypto.hash160(redeemScript);
        const scriptHashScript = bitcoin.script.scriptHash.output.encode(redeemScriptHash);
        const address = self.calculateRecoveryAddress(scriptHashScript);

        return {
          hash: scriptHashScript,
          witnessScript: witnessScript,
          redeemScript: redeemScript,
          address: address
        };
      }

      // ============================LOGIC============================
      if (_.isUndefined(params.userKey)) {
        throw new Error('missing userKey');
      }

      if (_.isUndefined(params.backupKey)) {
        throw new Error('missing backupKey');
      }

      if (_.isUndefined(params.recoveryDestination) || !this.isValidAddress(params.recoveryDestination)) {
        throw new Error('invalid recoveryDestination');
      }

      if (!_.isUndefined(params.scan) && (!_.isInteger(params.scan) || params.scan < 0)) {
        throw new Error('scan must be a positive integer');
      }

      // By default, we will ignore P2WSH until we officially support it
      if (_.isUndefined(params.ignoreAddressTypes)) {
        params.ignoreAddressTypes = [AbstractUtxoCoin.AddressTypes.P2WSH];
      }

      const isKrsRecovery = params.backupKey.startsWith('xpub') && !params.userKey.startsWith('xpub');
      const isUnsignedSweep = params.backupKey.startsWith('xpub') && params.userKey.startsWith('xpub');
      const krsProvider = config.krsProviders[params.krsProvider];

      if (isKrsRecovery && _.isUndefined(krsProvider)) {
        throw new Error('unknown key recovery service provider');
      }

      if (isKrsRecovery && !(krsProvider.supportedCoins.includes(this.getFamily()))) {
        throw new Error('specified key recovery service does not support recoveries for this coin');
      }

      const keys = yield this.initiateRecovery(params);

      const baseKeyPath = deriveKeys(deriveKeys(keys, 0), 0);

      const queries = [];

      _.forEach(AbstractUtxoCoin.AddressTypes, function(addressType) {
        // If we aren't ignoring the address type, we derive the public key and construct the query for the main and change indices
        if (!_.includes(params.ignoreAddressTypes, addressType)) {
          const mainIndex = AbstractUtxoCoin.AddressTypeChains[addressType].main;
          const changeIndex = AbstractUtxoCoin.AddressTypeChains[addressType].change;
          const mainKey = deriveKeys(baseKeyPath, mainIndex);
          const changeKey = deriveKeys(baseKeyPath, changeIndex);
          queries.push(queryBlockchainUnspentsPath(mainKey, '/0/0/' + mainIndex));
          queries.push(queryBlockchainUnspentsPath(changeKey, '/0/0/' + changeIndex));
        }
      });

      // Execute the queries and gather the unspents
      const addressesById = {};
      const queryResponses = yield Promise.all(queries);
      const unspents = _.flatten(queryResponses); // this flattens the array (turns an array of arrays into just one array)
      const totalInputAmount = _.sumBy(unspents, 'amount');
      if (totalInputAmount <= 0) {
        throw new Error('No input to recover - aborting!');
      }

      // Build the transaction
      const transactionBuilder = new bitcoin.TransactionBuilder(this.network);
      this.constructor.prepareTransactionBuilder(transactionBuilder);
      const txInfo = {};

      const feePerByte = yield this.getRecoveryFeePerBytes();

      // KRS recovery transactions have a 2nd output to pay the recovery fee, like paygo fees
      const outputSize = isKrsRecovery ? 2 * config.tx.OUTPUT_SIZE : config.tx.OUTPUT_SIZE;
      const approximateSize = config.tx.TX_OVERHEAD_SIZE + outputSize + (config.tx.P2SH_INPUT_SIZE * unspents.length);
      const approximateFee = approximateSize * feePerByte;

      // Construct a transaction
      txInfo.inputs = unspents.map(function addInputForUnspent(unspent) {
        const address = addressesById[unspent.address];
        const outputScript = address.hash;

        transactionBuilder.addInput(unspent.txid, unspent.n, 0xffffffff, outputScript);

        return {
          chainPath: address.chainPath,
          redeemScript: address.redeemScript.toString('hex'),
          witnessScript: address.witnessScript && address.witnessScript.toString('hex'),
          value: unspent.value_int
        };
      });

      let recoveryAmount = totalInputAmount - approximateFee;
      let krsFee;
      if (isKrsRecovery) {
        krsFee = yield this.calculateFeeAmount({ provider: params.krsProvider, amount: recoveryAmount });
        recoveryAmount -= krsFee;
      }

      if (recoveryAmount < 0) {
        throw new Error('this wallet\'s balance is too low to pay the fees specified by the KRS provider');
      }

      transactionBuilder.addOutput(params.recoveryDestination, recoveryAmount);

      if (isKrsRecovery && krsFee > 0) {
        const krsFeeAddress = krsProvider.feeAddresses[this.getChain()];

        if (!krsFeeAddress) {
          throw new Error('this KRS provider has not configured their fee structure yet - recovery cannot be completed');
        }

        transactionBuilder.addOutput(krsFeeAddress, krsFee);
      }

      if (isUnsignedSweep) {
        const txHex = transactionBuilder.buildIncomplete().toBuffer().toString('hex');
        return this.formatForOfflineVault(txInfo, txHex);
      } else {
        const signedTx = this.signRecoveryTransaction(transactionBuilder, unspents, addressesById, !isKrsRecovery);
        txInfo.transactionHex = signedTx.build().toBuffer().toString('hex');
        try {
          txInfo.tx = yield this.verifyRecoveryTransaction(txInfo);
        } catch (e) {
          throw new Error('could not verify recovery transaction');
        }
      }

      if (isKrsRecovery) {
        txInfo.coin = this.getChain();
        txInfo.backupKey = params.backupKey;
        txInfo.recoveryAmount = recoveryAmount;
      }

      return txInfo;
    }).call(this).asCallback(callback);
  }

  /**
   * Apply signatures to a funds recovery transaction using user + backup key
   * @param txb {Object} a transaction builder object (with inputs and outputs)
   * @param unspents {Array} the unspents to use in the transaction
   * @param addresses {Array} the address and redeem script info for the unspents
   * @param cosign {Boolean} whether to cosign this transaction with the user's backup key (false if KRS recovery)
   */
  signRecoveryTransaction(txb, unspents, addresses, cosign) {
    // sign the inputs
    const signatureIssues = [];
    unspents.forEach((unspent, i) => {
      const address = addresses[unspent.address];
      const backupPrivateKey = address.backupKey.keyPair;
      const userPrivateKey = address.userKey.keyPair;
      // force-override networks
      backupPrivateKey.network = this.network;
      userPrivateKey.network = this.network;

      const currentSignatureIssue = {
        inputIndex: i,
        unspent: unspent
      };

      if (cosign) {
        try {
          txb.sign(i, backupPrivateKey, address.redeemScript, this.constructor.defaultSigHashType, unspent.amount, address.witnessScript);
        } catch (e) {
          currentSignatureIssue.error = e;
          signatureIssues.push(currentSignatureIssue);
        }
      }

      try {
        txb.sign(i, userPrivateKey, address.redeemScript, this.constructor.defaultSigHashType, unspent.amount, address.witnessScript);
      } catch (e) {
        currentSignatureIssue.error = e;
        signatureIssues.push(currentSignatureIssue);
      }
    });

    if (signatureIssues.length > 0) {
      const failedIndices = signatureIssues.map(currentIssue => currentIssue.inputIndex);
      const error = new Error(`Failed to sign inputs at indices ${failedIndices.join(', ')}`);
      error.code = 'input_signature_failure';
      error.signingErrors = signatureIssues;
      throw error;
    }

    return txb;
  }

  /**
   * Calculates the amount (in base units) to pay a KRS provider when building a recovery transaction
   * @param params
   * @param params.provider {String} the KRS provider that holds the backup key
   * @param params.amount {Number} amount (in base units) to be recovered
   * @param callback
   * @returns {*}
   */
  calculateFeeAmount(params, callback) {
    return co(function *calculateFeeAmount() {
      const krsProvider = config.krsProviders[params.provider];

      if (krsProvider === undefined) {
        throw new Error(`no fee structure specified for provider ${params.provider}`);
      }

      if (krsProvider.feeType === 'flatUsd') {
        const feeAmountUsd = krsProvider.feeAmount;
        const currentPrice = yield this.getRecoveryMarketPrice();

        return Math.round(feeAmountUsd / currentPrice * this.getBaseFactor());
      } else {
        // we can add more fee structures here as needed for different providers, such as percentage of recovery amount
        throw new Error('Fee structure not implemented');
      }
    }).call(this).asCallback(callback);
  }

  /**
   * Recover BTC that was sent to the wrong chain
   * @param params
   * @param params.txid {String} The txid of the faulty transaction
   * @param params.recoveryAddress {String} address to send recovered funds to
   * @param params.wallet {Wallet} the wallet that received the funds
   * @param params.recoveryCoin {Coin} the coin type of the wallet that received the funds
   * @param params.signed {Boolean} return a half-signed transaction (default=true)
   * @param params.walletPassphrase {String} the wallet passphrase
   * @param params.xprv {String} the unencrypted xprv (used instead of wallet passphrase)
   * @param callback
   * @returns {*}
   */
  recoverFromWrongChain(params, callback) {
    return co(function *recoverFromWrongChain() {
      const {
        txid,
        recoveryAddress,
        wallet,
        walletPassphrase,
        xprv
      } = params;

      // params.recoveryCoin used to be params.coin, backwards compatibility
      const recoveryCoin = params.coin || params.recoveryCoin;
      // signed should default to true, and only be disabled if explicitly set to false (not undefined)
      const signed = params.signed !== false;

      const sourceCoinFamily = this.getFamily();
      const recoveryCoinFamily = recoveryCoin.getFamily();
      const supportedRecoveryCoins = config.supportedCrossChainRecoveries[sourceCoinFamily];

      if (_.isUndefined(supportedRecoveryCoins) || !supportedRecoveryCoins.includes(recoveryCoinFamily)) {
        throw new Error(`Recovery of ${sourceCoinFamily} balances from ${recoveryCoinFamily} wallets is not supported.`);
      }

      const recoveryTool = new RecoveryTool({
        bitgo: this.bitgo,
        sourceCoin: this,
        recoveryCoin: recoveryCoin,
        logging: false
      });

      yield recoveryTool.buildTransaction({
        wallet: wallet,
        faultyTxId: txid,
        recoveryAddress: recoveryAddress
      });

      if (signed) {
        yield recoveryTool.signTransaction({ passphrase: walletPassphrase, prv: xprv });
        return recoveryTool.export();
      } else {
        return yield recoveryTool.buildUnsigned();
      }
    }).call(this).asCallback(callback);
  }

  /**
   * Generate secp256k1 key pair
   *
   * @param seed
   * @returns {Object} object with generated pub and prv
   */
  generateKeyPair(seed) {
    if (!seed) {
      // An extended private key has both a normal 256 bit private key and a 256
      // bit chain code, both of which must be random. 512 bits is therefore the
      // maximum entropy and gives us maximum security against cracking.
      seed = crypto.randomBytes(512 / 8);
    }
    const extendedKey = prova.HDNode.fromSeedBuffer(seed);
    const xpub = extendedKey.neutered().toBase58();
    return {
      pub: xpub,
      prv: extendedKey.toBase58()
    };
  }

}

// add a static field that can only be done outside the class scope
AbstractUtxoCoin.AddressTypes = Object.freeze({
  P2SH: 'p2sh',
  P2SH_P2WSH: 'p2sh-p2wsh',
  P2WSH: 'p2wsh'
});

AbstractUtxoCoin.AddressTypeChains = Object.freeze({
  p2sh: {
    main: 0,
    change: 1
  },
  'p2sh-p2wsh': {
    main: 10,
    change: 11
  },
  p2wsh: {
    main: 20,
    change: 21
  }
});

module.exports = AbstractUtxoCoin;
