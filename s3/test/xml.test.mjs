import { test } from "node:test";
import assert from "node:assert/strict";
import { childText, findChild, findChildren, parseXml } from "../lib/xml.mjs";

test("parseXml reads nested elements, text, entities and CDATA", () => {
  const root = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<!-- comment -->
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name>
  <Contents><Key>a &amp; b &lt;c&gt; &#x41;&#66;</Key><Size>3</Size></Contents>
  <Contents><Key><![CDATA[x<y]]></Key><Size>4</Size></Contents>
  <IsTruncated>false</IsTruncated>
  <Empty/>
</ListBucketResult>`);
  assert.equal(root.name, "ListBucketResult");
  assert.equal(root.attributes.xmlns, "http://s3.amazonaws.com/doc/2006-03-01/");
  assert.equal(childText(root, "Name"), "bucket");
  assert.deepEqual(findChildren(root, "Contents").map((contents) => childText(contents, "Key")), ["a & b <c> AB", "x<y"]);
  assert.equal(childText(root, "Empty"), "");
  assert.equal(childText(root, "Missing"), undefined);
  assert.equal(findChild(root, "Missing"), undefined);
});

test("parseXml strips namespace prefixes from element names", () => {
  const root = parseXml('<s3:Error xmlns:s3="urn:x"><s3:Code>NoSuchKey</s3:Code></s3:Error>');
  assert.equal(root.name, "Error");
  assert.equal(childText(root, "Code"), "NoSuchKey");
});

test("parseXml refuses DTDs, entity declarations and malformed documents", () => {
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'), /DOCTYPE/);
  assert.throws(() => parseXml("<a><b></a>"), /mismatched/i);
  assert.throws(() => parseXml("<a>"), /unclosed/i);
  assert.throws(() => parseXml("<a>&unknown;</a>"), /entity/i);
  assert.throws(() => parseXml("just text"), /no root element/i);
});
