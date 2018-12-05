require('should');
require('should-http');
const request = require('supertest-as-promised');
const co = require('bluebird').coroutine;
const expressApp = require('../../../src/expressApp').app;
const nock = require('nock');
const common = require('../../../src/common');

describe('Bitgo Express', function() {
  if (process.browser) {
    // Bitgo Express tests not supported in browser
    this.skip();
  }

  describe('verify address', function() {
    let agent;
    before(() => {
      const args = {
        debug: false,
        env: 'test',
        logfile: '/dev/null'
      };

      const app = expressApp(args);
      agent = request.agent(app);
    });

    describe('failure', function() {
      it('should mark as invalid bad btc address', co(function *() {
        const res = yield agent.post('/api/v2/btc/verifyaddress')
        .send({ address: '3P14159f73E4gFr7JterCCQh9QjiTjiZrR' });

        res.should.have.status(200);
        res.body.isValid.should.equal(false);
      }));

      it('should mark as invalid bad ltc address', co(function *() {
        const res = yield agent.post('/api/v2/ltc/verifyaddress')
        .send({ address: '3Ps3MeHaYm2s5WPsRo1kHkCvS8EFawzG7R' });

        res.should.have.status(200);
        res.body.isValid.should.equal(false);
      }));

      it('should mark as invalid bad tltc address', co(function *() {
        const res = yield agent.post('/api/v2/tltc/verifyaddress')
        .send({ address: 'QeKCcxtfqprzZsWZihRgxJk2QJrrLMjS4s' });

        res.should.have.status(200);
        res.body.isValid.should.equal(false);
      }));

      it('should mark as invalid bad tltc address when not allowing old script hash version', co(function *() {
        const res = yield agent.post('/api/v2/ltc/verifyaddress')
        .send({ address: '3Ps3MeHaYm2s5WPsRo1kHkCvS8EFawzG7Q' });

        res.should.have.status(200);
        res.body.isValid.should.equal(false);
      }));

      it('should mark as invalid bad eth address', co(function *() {
        const res = yield agent.post('/api/v2/eth/verifyaddress')
        .send({ address: '0xd4a4aa09f57b7e83cd817ec24df9f86daf253d1' });

        res.should.have.status(200);
        res.body.isValid.should.equal(false);
      }));

      it('should mark as invalid bad xrp address', co(function *() {
        const res = yield agent.post('/api/v2/xrp/verifyaddress')
        .send({ address: 'rw5bfvumHWZirKLG5gUQ89dyqtiUUbmxP' });

        res.should.have.status(200);
        res.body.isValid.should.equal(false);
      }));

    });

    describe('success', function() {
      it('should verify valid btc address', co(function *() {
        const res = yield agent.post('/api/v2/btc/verifyaddress')
        .send({ address: '3P14159f73E4gFr7JterCCQh9QjiTjiZrG' });

        res.should.have.status(200);
        res.body.isValid.should.equal(true);
      }));

      it('should verify valid tbtc address', co(function *() {
        const res = yield agent.post('/api/v2/tbtc/verifyaddress')
        .send({ address: '2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc' });

        res.should.have.status(200);
        res.body.isValid.should.equal(true);
      }));

      it('should verify valid ltc address', co(function *() {
        const res = yield agent.post('/api/v2/ltc/verifyaddress')
        .send({ address: 'MW5BfXhYVstHt1fmXg167PTKkpphfP6xQ3' });

        res.should.have.status(200);
        res.body.isValid.should.equal(true);
      }));

      it('should verify old-style P2SH ltc address when allowing old script hash version', co(function *() {
        const res = yield agent.post('/api/v2/ltc/verifyaddress')
        .send({
          address: '3Ps3MeHaYm2s5WPsRo1kHkCvS8EFawzG7Q',
          supportOldScriptHashVersion: true
        });

        res.should.have.status(200);
        res.body.isValid.should.equal(true);
      }));

      it('should verify tltc address', co(function *() {
        const res = yield agent.post('/api/v2/tltc/verifyaddress')
        .send({ address: 'QeKCcxtfqprzZsWZihRgxJk2QJrrLMjS4c' });

        res.should.have.status(200);
        res.body.isValid.should.equal(true);
      }));

      it('should verify valid eth address', co(function *() {
        const res = yield agent.post('/api/v2/eth/verifyaddress')
        .send({ address: '0xd4a4aa09f57b7e83cd817ec24df9f86daf253d1d' });

        res.should.have.status(200);
        res.body.isValid.should.equal(true);
      }));

      it('should verify valid xrp address', co(function *() {
        const res = yield agent.post('/api/v2/xrp/verifyaddress')
        .send({ address: 'rw5bfvumHWZirKLG5gUQ89dyqtiUUbmxPD' });

        res.should.have.status(200);
        res.body.isValid.should.equal(true);
      }));
    });
  });

  describe('proxy error handling', () => {
    let agent;
    before(() => {
      const args = {
        debug: true,
        env: 'test',
        timeout: 500
      };

      const app = expressApp(args);
      agent = request.agent(app);
    });

    it('should handle ECONNRESET errors from the proxy server', co(function *() {
      const path = '/api/v2/ping';

      // client constants are retrieved upon BitGo
      // object creation so they need to be nocked
      nock(common.Environments.test.uri)
      .get('/api/v1/client/constants')
      .reply(200, {});

      // first request to ping endpoint should time out
      nock(common.Environments.test.uri)
      .post(path)
      .socketDelay(1000)
      .reply(200);

      // we should return 500 in the case of a timeout
      let pingRes = yield agent.post(path).send({});
      pingRes.should.have.status(500);

      nock(common.Environments.test.uri)
      .post(path)
      .reply(200);

      pingRes = yield agent.post(path).send({});
      pingRes.should.have.status(200);
    }));
  });
});
