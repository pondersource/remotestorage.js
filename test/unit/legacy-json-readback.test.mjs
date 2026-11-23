import 'mocha';
import { expect } from 'chai';
import { localStorage } from '../helpers/memoryStorage.mjs';
import { jsonReadbackContract } from '../helpers/json-readback-contract.mjs';
import Dropbox from '../../build/dropbox.js';
import GoogleDrive from '../../build/googledrive.js';
import { BaseClient } from '../../build/baseclient.js';

const TYPE = 'application/json; charset=UTF-8';
const ACKNOWLEDGED = '{ "title": "first", "unknown": [1, 2], "unicode": "Café" }\n';
const PENDING = '{"title":"pending"}';
const bytes = text => new TextEncoder().encode(text).buffer;

function dropbox(text) {
  const rs = { apiKeys: { dropbox: { appKey: 'public-test-key' } }, _emit() {} };
  const backend = new Dropbox(rs);
  backend.connected = true;
  backend._initialFetchDone = true;
  // Keep the actual adapter's download/decode/revision/MIME path. Only the
  // HTTP boundary is replaced; no live provider/CAS behavior is inferred.
  backend._request = async () => ({ status: 200, response: bytes(text), getResponseHeader: name =>
    name === 'Dropbox-API-Result' ? JSON.stringify({ rev: 'verified' }) : 'application/octet-stream' });
  return backend;
}

function googleDrive(text) {
  const backend = new GoogleDrive({ _emit() {} }, 'public-test-client');
  backend.connected = true;
  backend._getFileId = async () => 'file';
  backend._getMeta = async () => ({ etag: '"verified"', mimeType: TYPE, downloadUrl: 'https://download.example.test/file' });
  backend._request = async () => ({ status: 200, response: bytes(text) });
  return backend;
}

for (const [name, fixture] of [['Dropbox', dropbox], ['Google Drive', googleDrive]]) {
  describe(`${name} JSON transport and actual Sync readback`, () => {
    beforeEach(() => {
      localStorage.removeItem('remotestorage:dropbox');
      localStorage.removeItem('remotestorage:googledrive');
    });

    it('retains a pending edit when downloaded JSON revalidates an acknowledged write', async () => {
      const backend = fixture(ACKNOWLEDGED);
      await jsonReadbackContract(await backend.get('/notes/record.json'), ACKNOWLEDGED, PENDING, TYPE);
    });

    it('preserves native JSON whitespace and unknown fields while BaseClient.getObject parses it', async () => {
      const backend = fixture(ACKNOWLEDGED);
      const response = await backend.get('/notes/record.json');
      expect(response.body).to.equal(ACKNOWLEDGED);
      expect(response.contentType).to.equal(TYPE);
      const client = new BaseClient({ onChange() {}, get: path => backend.get(path) }, '/notes/');
      expect((await client.getFile('record.json')).data).to.equal(ACKNOWLEDGED);
      expect(await client.getObject('record.json')).to.deep.equal(JSON.parse(ACKNOWLEDGED));
    });
  });
}
