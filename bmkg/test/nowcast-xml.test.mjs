import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeXmlText, parseCapAlert, parseNowcastFeed } from "../lib/nowcast-xml.mjs";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Peringatan Dini Cuaca BMKG</title>
  <lastBuildDate>Thu, 19 Nov 2026 02:00:50 +0000</lastBuildDate>
  <item>
    <title>Hujan Lebat disertai Petir di Nusa Tenggara Barat</title>
    <link>https://www.bmkg.go.id/alerts/nowcast/id/CNB20261119001_alert.xml</link>
    <description>Hujan lebat &amp; petir di LEMBAR, PUJUT.</description>
    <author>BMKG</author>
    <pubDate>Thu, 19 Nov 2026 09:35:00 +0800</pubDate>
  </item>
  <item>
    <title><![CDATA[Hujan Sedang <Lebat> di Bali]]></title>
    <link>https://www.bmkg.go.id/alerts/nowcast/id/CBL20261119002_alert.xml</link>
    <description>Bali &#8211; Denpasar &#x26; Badung</description>
    <pubDate>Thu, 19 Nov 2026 09:40:00 +0800</pubDate>
  </item>
</channel></rss>`;

const CAP = `<?xml version="1.0" ?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>2.49.0.1.360.0.2026.11.19.02.52.001</identifier>
  <sent>2026-11-19T09:35:00+08:00</sent>
  <info>
    <language>id</language>
    <event>Hujan Lebat dan Petir</event>
    <urgency>Immediate</urgency>
    <severity>Moderate</severity>
    <certainty>Observed</certainty>
    <effective>2026-11-19T09:45:00+08:00</effective>
    <expires>2026-11-19T11:00:00+08:00</expires>
    <senderName>Badan Meteorologi Klimatologi dan Geofisika</senderName>
    <headline>Hujan Lebat disertai Petir di Nusa Tenggara Barat</headline>
    <description>Hujan lebat akan terjadi.</description>
    <web>https://nowcasting.bmkg.go.id/infografis/CNB/2026/11/19/infografis.jpg</web>
    <area>
      <areaDesc>Nusa Tenggara Barat</areaDesc>
      <polygon>-8.677,116.069 -8.680,116.073 -8.677,116.069</polygon>
      <polygon>-8.757,116.281 -8.762,116.286 -8.757,116.281</polygon>
    </area>
  </info>
</alert>`;

test("decodeXmlText decodes entities, numeric references and CDATA", () => {
  assert.equal(decodeXmlText("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#8211; &#x26;"), "a & b <c> \"d\" 'e' – &");
  assert.equal(decodeXmlText("<![CDATA[x &amp; <y>]]>"), "x &amp; <y>");
  assert.equal(decodeXmlText("  padded\n "), "padded");
});

test("parseNowcastFeed returns one entry per item with the alert code from the link", () => {
  const feed = parseNowcastFeed(FEED);
  assert.equal(feed.updated_at, "Thu, 19 Nov 2026 02:00:50 +0000");
  assert.equal(feed.warnings.length, 2);
  assert.deepEqual(feed.warnings[0], {
    alert_code: "CNB20261119001",
    title: "Hujan Lebat disertai Petir di Nusa Tenggara Barat",
    description: "Hujan lebat & petir di LEMBAR, PUJUT.",
    author: "BMKG",
    published_at: "Thu, 19 Nov 2026 09:35:00 +0800",
    link: "https://www.bmkg.go.id/alerts/nowcast/id/CNB20261119001_alert.xml",
  });
  assert.equal(feed.warnings[1].title, "Hujan Sedang <Lebat> di Bali");
  assert.equal(feed.warnings[1].description, "Bali – Denpasar & Badung");
  assert.equal(feed.warnings[1].author, null);
});

test("parseNowcastFeed refuses a body that is not an RSS feed", () => {
  assert.throws(() => parseNowcastFeed("<html><body>Just a moment...</body></html>"), (error) => error.kind === "api_error" && /RSS/.test(error.message));
});

test("parseCapAlert extracts the CAP fields and the area polygons as coordinate pairs", () => {
  const alert = parseCapAlert(CAP);
  assert.equal(alert.identifier, "2.49.0.1.360.0.2026.11.19.02.52.001");
  assert.equal(alert.event, "Hujan Lebat dan Petir");
  assert.equal(alert.severity, "Moderate");
  assert.equal(alert.effective, "2026-11-19T09:45:00+08:00");
  assert.equal(alert.expires, "2026-11-19T11:00:00+08:00");
  assert.equal(alert.infographic_url, "https://nowcasting.bmkg.go.id/infografis/CNB/2026/11/19/infografis.jpg");
  assert.equal(alert.area_description, "Nusa Tenggara Barat");
  assert.deepEqual(alert.polygons[0], [[-8.677, 116.069], [-8.68, 116.073], [-8.677, 116.069]]);
  assert.equal(alert.polygons.length, 2);
});

test("parseCapAlert can leave out the polygons and refuses non-CAP bodies", () => {
  assert.equal(parseCapAlert(CAP, { includePolygons: false }).polygons, undefined);
  assert.throws(() => parseCapAlert("<rss></rss>"), (error) => error.kind === "api_error" && /CAP/.test(error.message));
});
