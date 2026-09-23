from mcp.server.fastmcp import FastMCP
import httpx
import trafilatura

mcp = FastMCP(
    'web-tools',
    host='0.0.0.0',
    port=28766,
    stateless_http=True,
    json_response=True,
    streamable_http_path='/mcp',
)

USER_AGENT = (
    'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'
)
MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024  # 5 MB
MAX_OUTPUT_CHARS = 20_000


@mcp.tool(
    annotations={'readOnlyHint': True, 'openWorldHint': True}
)
def web_fetch(url: str) -> str:
    """Fetch a web page and extract its main article text content.

    Returns the page title, final URL, and readable text (navigation,
    scripts and ads removed). Binary files and JS-only pages will not
    yield content — for those, use another tool.

    Args:
        url: Full http(s) URL of the page to fetch.

    Returns:
        Structured text: title, URL, and extracted content (truncated
        to ~20k characters, with a notice when truncated).
    """
    try:
        parsed = httpx.URL(url)
        if parsed.scheme not in ('http', 'https'):
            return f'Unsupported URL scheme "{parsed.scheme}". Use http or https.'
    except Exception as e:
        return f'Invalid URL "{url}": {e}'

    headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    }

    try:
        with httpx.Client(
            headers=headers, timeout=20.0, follow_redirects=True
        ) as client:
            r = client.get(url)
    except httpx.TimeoutException:
        return f'Fetch timeout after 20s for {url}. The host may be slow or unreachable.'
    except httpx.ConnectError as e:
        return f'Connection failed for {url}: {e}. Check the hostname/network.'
    except httpx.HTTPError as e:
        return f'HTTP error fetching {url}: {e}'

    content_type = r.headers.get('content-type', '')
    if r.status_code >= 400:
        return (
            f'HTTP {r.status_code} from {r.url}. '
            + (
                'The page may require authentication or has moved.'
                if r.status_code in (401, 403)
                else 'Verify the URL is correct and the resource still exists.'
            )
        )
    if 'json' in content_type or 'xml' in content_type or 'pdf' in content_type:
        return (
            f'Fetched {r.url} is {content_type.strip().lower() or "binary"}, '
            'not HTML — web_fetch only extracts text from HTML pages. '
            'Download the raw file with curl if needed.'
        )

    # r.content is a bytes slice: decode with replacement so a cut
    # multi-byte char at the byte cap never crashes the request.
    html_text = r.content[:MAX_DOWNLOAD_BYTES].decode('utf-8', errors='replace')

    title = ''
    try:
        from trafilatura.metadata import get_title
        title = get_title(html_text) or ''
    except Exception:
        pass
    if not title:
        from html.parser import HTMLParser
        class _T(HTMLParser):
            def __init__(self):
                super().__init__()
                self._t = ''
                self._in = False
            def handle_starttag(self, tag, attrs):
                if tag == 'title':
                    self._in = True
            def handle_endtag(self, tag):
                if tag == 'title':
                    self._in = False
            def handle_data(self, data):
                if self._in:
                    self._t += data
        try:
            p = _T()
            p.feed(html_text[:200_000])
            p.close()
            title = ' '.join(p._t.split())
        except Exception:
            pass
    text = trafilatura.extract(
        html_text,
        include_comments=False,
        include_tables=True,
        favor_recall=True,
    )
    if not text:
        return (
            f'Fetched {r.url} (HTTP {r.status_code}) but no readable text was '
            'extracted — the page is likely JS-rendered, empty, or non-article. '
            'Try a search instead, or fetch a different URL.'
        )

    truncated = len(text) > MAX_OUTPUT_CHARS
    text = text[:MAX_OUTPUT_CHARS]
    if truncated:
        return f'Title: {title}\nURL: {r.url}\n\n{text}\n\n[... truncated ...]'
    return f'Title: {title}\nURL: {r.url}\n\n{text}'


if __name__ == '__main__':
    mcp.run(transport='streamable-http')
