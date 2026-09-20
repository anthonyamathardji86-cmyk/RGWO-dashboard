// ===================================
// DOCUMENTS — Fetch from Supabase
// ===================================

var CATEGORY_CONFIG = {
    formulieren:  { icon: '📝', label: 'Formulieren',   color: '#3b82f6' },
    documenten:   { icon: '📄', label: 'Documenten',    color: '#10b981' },
    reglementen:  { icon: '📋', label: 'Reglementen',   color: '#f59e0b' },
    verslagen:    { icon: '📊', label: 'Verslagen',     color: '#8b5cf6' },
    circulaires:  { icon: '📨', label: 'Circulaires',   color: '#ec4899' },
    overig:       { icon: '📁', label: 'Overig',        color: '#6b7280' }
};

function getFileIcon(type) {
    var icons = {
        pdf: '📕', doc: '📘', docx: '📘',
        xls: '📗', xlsx: '📗',
        ppt: '📙', pptx: '📙',
        png: '🖼️', jpg: '🖼️', jpeg: '🖼️'
    };
    return icons[type] || '📄';
}

function loadDocuments() {
    return fetch('/api/documents/grouped')
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.success) return data.grouped;
            return {};
        })
        .catch(function(err) {
            console.error('Failed to load documents:', err);
            return {};
        });
}

function renderDocumentButtons() {
    loadDocuments().then(function(grouped) {
        var container = document.getElementById('doc-buttons');
        if (!container) return;

        container.innerHTML = '';

        var allCategories = Object.keys(CATEGORY_CONFIG);

        allCategories.forEach(function(category) {
            var config = CATEGORY_CONFIG[category];
            var docs = grouped[category] || [];
            var count = docs.length;

            var btn = document.createElement('button');
            btn.className = 'doc-category-btn';
            btn.innerHTML =
                '<span class="doc-icon">' + config.icon + '</span>' +
                '<span class="doc-label">' + config.label + '</span>' +
                '<span class="doc-count ' + (count === 0 ? 'empty' : '') + '">' + count + '</span>';
            btn.style.setProperty('--btn-color', config.color);
            btn.onclick = function() { openDocumentModal(category, docs); };
            container.appendChild(btn);
        });
    });
}

function openDocumentModal(category, docs) {
    var config = CATEGORY_CONFIG[category];

    var docsHtml = '';
    if (docs.length === 0) {
        docsHtml = '<p class="doc-empty">Nog geen documenten beschikbaar in deze categorie.</p>';
    } else {
        docs.forEach(function(doc) {
            docsHtml +=
                '<a href="' + doc.url + '" target="_blank" class="doc-item" rel="noopener">' +
                    '<span class="doc-item-icon">' + getFileIcon(doc.type) + '</span>' +
                    '<div class="doc-item-info">' +
                        '<span class="doc-item-title">' + doc.title + '</span>' +
                        (doc.description ? '<span class="doc-item-desc">' + doc.description + '</span>' : '') +
                    '</div>' +
                    '<span class="doc-item-arrow">↗</span>' +
                '</a>';
        });
    }

    var modal = document.createElement('div');
    modal.className = 'doc-modal-overlay';
    modal.innerHTML =
        '<div class="doc-modal">' +
            '<div class="doc-modal-header">' +
                '<h2>' + config.icon + ' ' + config.label + '</h2>' +
                '<button class="doc-modal-close" onclick="this.closest(\'.doc-modal-overlay\').remove()">✕</button>' +
            '</div>' +
            '<div class="doc-modal-body">' +
                docsHtml +
            '</div>' +
        '</div>';
    document.body.appendChild(modal);

    modal.addEventListener('click', function(e) {
        if (e.target === modal) modal.remove();
    });
}

document.addEventListener('DOMContentLoaded', function() {
    renderDocumentButtons();
});
