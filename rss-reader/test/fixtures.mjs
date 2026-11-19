/**
 * Small feeds in each supported format.
 */
export const RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Example News</title>
    <link>https://news.example.com/</link>
    <atom:link href="https://news.example.com/feed.xml" rel="self" type="application/rss+xml"/>
    <description>All the news</description>
    <language>en</language>
    <lastBuildDate>Wed, 18 Nov 2026 10:00:00 GMT</lastBuildDate>
    <item>
      <title>Second story</title>
      <link>https://news.example.com/2</link>
      <guid isPermaLink="false">story-2</guid>
      <pubDate>Wed, 18 Nov 2026 09:00:00 +0000</pubDate>
      <dc:creator>Ann Writer</dc:creator>
      <category>World</category>
      <category>Politics</category>
      <description>&lt;p&gt;Short &amp;amp; &lt;b&gt;sweet&lt;/b&gt;&lt;/p&gt;</description>
      <content:encoded><![CDATA[<p>Full <em>text</em> here.</p><script>alert(1)</script>]]></content:encoded>
      <enclosure url="https://cdn.example.com/2.mp3" type="audio/mpeg" length="1234"/>
    </item>
    <item>
      <title>First story</title>
      <link>https://news.example.com/1</link>
      <pubDate>Mon, 16 Nov 2026 09:00:00 GMT</pubDate>
      <description>Plain summary</description>
    </item>
  </channel>
</rss>`;

export const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Example Blog</title>
  <link href="https://blog.example.com/" rel="alternate"/>
  <link href="https://blog.example.com/atom.xml" rel="self"/>
  <updated>2026-11-18T10:00:00Z</updated>
  <subtitle>Notes</subtitle>
  <entry>
    <title type="html">Hello &amp;lt;World&amp;gt;</title>
    <link rel="alternate" type="text/html" href="https://blog.example.com/hello"/>
    <link rel="enclosure" type="image/png" href="https://blog.example.com/hello.png" length="10"/>
    <id>tag:blog.example.com,2026:1</id>
    <published>2026-11-17T08:00:00Z</published>
    <updated>2026-11-18T08:00:00+01:00</updated>
    <author><name>Bo Author</name></author>
    <category term="notes"/>
    <summary type="html">&lt;p&gt;A summary&lt;/p&gt;</summary>
    <content type="html">&lt;p&gt;The content&lt;/p&gt;</content>
  </entry>
</feed>`;

export const RDF_FEED = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://old.example.com/">
    <title>Old Site</title>
    <link>https://old.example.com/</link>
    <description>RSS 1.0</description>
  </channel>
  <item rdf:about="https://old.example.com/a">
    <title>Item A</title>
    <link>https://old.example.com/a</link>
    <dc:date>2026-11-01T00:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

export const JSON_FEED = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "JSON Example",
  home_page_url: "https://json.example.com/",
  feed_url: "https://json.example.com/feed.json",
  description: "A JSON feed",
  language: "en",
  items: [
    {
      id: "1",
      url: "https://json.example.com/1",
      title: "JSON item",
      content_html: "<p>Hi <b>there</b></p>",
      summary: "Hi there",
      date_published: "2026-11-18T09:00:00Z",
      authors: [{ name: "Cy" }],
      tags: ["a", "b"],
      attachments: [{ url: "https://json.example.com/1.mp3", mime_type: "audio/mpeg", size_in_bytes: 99 }],
    },
  ],
});
