import { expect } from 'chai';
import { equalContentTypes } from '../../build/content-type.js';

describe('HTTP representation media type equality', function() {
  it('recognizes normalized charset spelling, quoting and parameter order', function() {
    expect(equalContentTypes('application/json; charset=UTF-8', 'application/json;charset=utf-8')).to.equal(true);
    expect(equalContentTypes(' Application/JSON ; Charset="UTF-8"; profile="https://example.test/A;B" ',
      'application/json;profile="https://example.test/A;B";charset=utf-8')).to.equal(true);
    expect(equalContentTypes('text/plain; note="a\\b"', 'text/plain;note=ab')).to.equal(true);
  });

  it('retains every unknown parameter and case-sensitive value', function() {
    for (const [left, right] of [
      ['application/json;charset=utf-8', 'application/json;charset=utf-16'],
      ['application/json;charset=utf-16', 'application/json'],
      ['text/plain;charset=utf-8', 'text/plain'],
      ['application/vnd.note+json;charset=utf-8', 'application/vnd.note+json'],
      ['application/json;profile="https://example.test/A"', 'application/json;profile="https://example.test/a"'],
      ['application/json;profile=one', 'application/json;profile=two'],
      ['multipart/form-data;boundary=AbC', 'multipart/form-data;boundary=abc']
    ]) expect(equalContentTypes(left, right)).to.equal(false);
  });

  it('recognizes only the registered application/json UTF-8 default', function() {
    expect(equalContentTypes('application/json; charset=UTF-8', 'application/json')).to.equal(true);
    expect(equalContentTypes('application/json;profile=one;charset="UTF-8"', 'application/json; profile=one')).to.equal(true);
  });

  it('does not guess equivalence for malformed or duplicate parameters', function() {
    for (const [left, right] of [
      ['application/json; charset=utf-8; charset=utf-16', 'APPLICATION/JSON; charset=utf-8; charset=utf-16'],
      ['application/json;profile="unfinished', 'application/json; profile="unfinished'],
      ['application/json;profile=x\r\n', 'application/json;profile=x'],
      ['application/json;', 'application/json'],
      ['application/json;charset =utf-8', 'application/json;charset=utf-8'],
      [undefined, 'application/json']
    ]) expect(equalContentTypes(left, right)).to.equal(false);
    expect(equalContentTypes('opaque invalid type', 'opaque invalid type')).to.equal(true);
  });
});
