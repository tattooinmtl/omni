/**
 * ES Module Application Logic
 */

class WebApp {
  constructor() {
    this.items = [];
    this.initElements();
    this.bindEvents();
    this.render();
  }

  initElements() {
    this.themeBtn = document.getElementById('theme-toggle');
    this.form = document.getElementById('action-form');
    this.input = document.getElementById('task-input');
    this.list = document.getElementById('item-list');
  }

  bindEvents() {
    if (this.themeBtn) {
      this.themeBtn.addEventListener('click', () => this.toggleTheme());
    }

    if (this.form) {
      this.form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.addItem(this.input.value);
        this.input.value = '';
      });
    }

    // Event delegation for list item deletion
    if (this.list) {
      this.list.addEventListener('click', (e) => {
        if (e.target.matches('.delete-btn')) {
          const id = e.target.dataset.id;
          this.removeItem(id);
        }
      });
    }
  }

  toggleTheme() {
    const currentTheme = document.body.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.body.setAttribute('data-theme', newTheme);
  }

  addItem(title) {
    if (!title.trim()) return;
    const item = {
      id: 'item_' + Date.now(),
      title: title.trim(),
      createdAt: new Date().toLocaleTimeString()
    };
    this.items.push(item);
    this.render();
  }

  removeItem(id) {
    this.items = this.items.filter(item => item.id !== id);
    this.render();
  }

  render() {
    if (!this.list) return;

    if (this.items.length === 0) {
      this.list.innerHTML = '<li class="item-card" style="color: var(--text-muted)">No pipeline items added yet.</li>';
      return;
    }

    this.list.innerHTML = this.items.map(item => `
      <li class="item-card">
        <div>
          <strong>${this.escapeHtml(item.title)}</strong>
          <span style="display: block; font-size: 0.75rem; color: var(--text-muted)">Added at ${item.createdAt}</span>
        </div>
        <button class="btn btn-secondary delete-btn" data-id="${item.id}" aria-label="Remove ${this.escapeHtml(item.title)}">
          Remove
        </button>
      </li>
    `).join('');
  }

  escapeHtml(str) {
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new WebApp();
});
