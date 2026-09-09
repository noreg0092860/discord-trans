// 最小 DOM 模擬：把 HTML 片段解析成 DT.extractText 需要的節點介面（nodeType/tagName/getAttribute/childNodes/nodeValue）。
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source']);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(str) {
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

function textNode(value) {
  return { nodeType: 3, nodeValue: value, childNodes: [] };
}

function elementNode(tagName, attrs) {
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    attributes: attrs,
    childNodes: [],
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
  };
}

function parseAttrs(raw) {
  const attrs = {};
  if (!raw) return attrs;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw))) {
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs[m[1].toLowerCase()] = decode(value);
  }
  return attrs;
}

// 回傳最外層元素；若片段有多個根，包成一個 <div>。
function parseHTML(html) {
  const root = elementNode('div', {});
  const stack = [root];
  let cursor = 0;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html))) {
    if (m.index > cursor) stack[stack.length - 1].childNodes.push(textNode(decode(html.slice(cursor, m.index))));
    cursor = TAG_RE.lastIndex;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }
    const node = elementNode(tag, parseAttrs(m[3]));
    stack[stack.length - 1].childNodes.push(node);
    if (!VOID_TAGS.has(tag) && m[4] !== '/') stack.push(node);
  }
  if (cursor < html.length) stack[stack.length - 1].childNodes.push(textNode(decode(html.slice(cursor))));
  return root.childNodes.length === 1 && root.childNodes[0].nodeType === 1 ? root.childNodes[0] : root;
}

module.exports = { parseHTML };
