import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeSubtitle,
  srtToVtt,
  toVtt,
  sortSubtitles,
  langLabel,
  normalizeLang,
} from '../public/js/shared/subtitle-text.js';

const enc = (s) => new TextEncoder().encode(s);

test('decodeSubtitle keeps valid UTF-8 and strips BOM', () => {
  assert.equal(decodeSubtitle(enc('\uFEFFğüşıöç İĞÜŞÖÇ'), 'tur'), 'ğüşıöç İĞÜŞÖÇ');
});

test('decodeSubtitle falls back to windows-1254 for Turkish', () => {
  const bytes = new Uint8Array([0xf0, 0xfc, 0xfe, 0xfd, 0xf6, 0xe7, 0x20, 0xdd, 0xd0, 0xde]);
  assert.equal(decodeSubtitle(bytes, 'tur'), 'ğüşıöç İĞŞ');
});

test('decodeSubtitle picks the code page by language', () => {
  const cyr = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет" in windows-1251
  assert.equal(decodeSubtitle(cyr, 'rus'), 'Привет');
  assert.equal(decodeSubtitle(new Uint8Array([0xe9]), 'fre'), 'é');
});

test('decodeSubtitle handles UTF-16 LE BOM', () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x1f, 0x01, 0x61, 0x00]); // "ğa"
  assert.equal(decodeSubtitle(bytes, 'tur'), 'ğa');
});

test('srtToVtt converts timestamps and strips unsupported tags', () => {
  const srt = '1\r\n00:00:01,500 --> 00:00:03,000\r\n{\\an8}<font color="#fff">Merhaba</font> <i>dünya</i>\r\n\r\n2\r\n00:01:02,003 --> 00:01:04,000\r\nİkinci, satır\r\n';
  assert.equal(
    srtToVtt(srt),
    'WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nMerhaba <i>dünya</i>\n\n2\n00:01:02.003 --> 00:01:04.000\nİkinci, satır\n',
  );
});

test('toVtt passes WebVTT through and converts SRT', () => {
  assert.equal(toVtt('WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nx'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nx');
  assert.ok(toVtt('1\n00:00:01,000 --> 00:00:02,000\nx').startsWith('WEBVTT\n\n'));
});

test('normalizeLang maps common codes', () => {
  assert.equal(normalizeLang('tr'), 'tur');
  assert.equal(normalizeLang('EN'), 'eng');
  assert.equal(normalizeLang('tur'), 'tur');
  assert.equal(normalizeLang(''), 'und');
});

test('sortSubtitles puts Turkish, then English, then others by label; matched first within a language', () => {
  const list = [
    { subId: 'a', lang: 'ger', matched: false },
    { subId: 'b', lang: 'eng', matched: false },
    { subId: 'c', lang: 'tur', matched: false },
    { subId: 'd', lang: 'ara', matched: false },
    { subId: 'e', lang: 'tur', matched: true },
  ];
  assert.deepEqual(sortSubtitles(list).map((s) => s.subId), ['e', 'c', 'b', 'a', 'd']);
  assert.equal(langLabel('tur'), 'Türkçe');
  assert.equal(langLabel('xyz'), 'xyz');
});
