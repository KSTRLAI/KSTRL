import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(text) {
  const html = marked.parse(text || '');
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}
