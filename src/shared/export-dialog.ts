export function showExportDialog(
  container: HTMLElement,
  isDark: boolean
): Promise<{ percentage: number; format: 'md' | 'txt' | 'json' } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = `cut-export-modal-overlay ${isDark ? 'cut-dark' : ''}`;
    
    // Add CSS explicitly for the popup if not already present, or rely on a shared stylesheet
    if (!document.getElementById('cut-export-modal-styles')) {
      const style = document.createElement('style');
      style.id = 'cut-export-modal-styles';
      style.textContent = `
        .cut-export-modal-overlay {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0, 0, 0, 0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
          opacity: 0;
          transition: opacity 0.2s ease;
          border-radius: inherit;
        }
        .cut-export-modal {
          background: #ffffff;
          border-radius: 12px;
          padding: 16px;
          width: 240px;
          box-shadow: 0 10px 25px rgba(0,0,0,0.15);
          transform: scale(0.95) translateY(10px);
          transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
          font-family: system-ui, -apple-system, sans-serif;
          color: #333;
        }
        .cut-export-modal-overlay.cut-dark .cut-export-modal {
          background: #2a2a2a;
          color: #eee;
          box-shadow: 0 10px 25px rgba(0,0,0,0.4);
        }
        .cut-export-modal.show {
          transform: scale(1) translateY(0);
        }
        .cut-export-title {
          margin: 0 0 12px 0;
          font-size: 15px;
          font-weight: 600;
        }
        .cut-export-group {
          margin-bottom: 12px;
        }
        .cut-export-label {
          display: block;
          font-size: 12px;
          margin-bottom: 4px;
          color: #666;
        }
        .cut-export-modal-overlay.cut-dark .cut-export-label {
          color: #aaa;
        }
        .cut-export-input, .cut-export-select {
          width: 100%;
          padding: 6px 8px;
          border: 1px solid #ccc;
          border-radius: 6px;
          font-size: 13px;
          box-sizing: border-box;
          background: #fff;
          color: #333;
        }
        .cut-export-modal-overlay.cut-dark .cut-export-input,
        .cut-export-modal-overlay.cut-dark .cut-export-select {
          background: #1e1e1e;
          border-color: #444;
          color: #eee;
        }
        .cut-export-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 16px;
        }
        .cut-export-btn {
          padding: 6px 12px;
          border: none;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
        }
        .cut-export-btn-cancel {
          background: transparent;
          color: #666;
        }
        .cut-export-modal-overlay.cut-dark .cut-export-btn-cancel {
          color: #aaa;
        }
        .cut-export-btn-cancel:hover {
          background: rgba(0,0,0,0.05);
        }
        .cut-export-modal-overlay.cut-dark .cut-export-btn-cancel:hover {
          background: rgba(255,255,255,0.05);
        }
        .cut-export-btn-confirm {
          background: #e38259;
          color: white;
        }
        .cut-export-btn-confirm:hover {
          background: #d47650;
        }
      `;
      document.head.appendChild(style);
    }

    overlay.innerHTML = `
      <div class="cut-export-modal">
        <h3 class="cut-export-title">Export Chat</h3>
        <div class="cut-export-group">
          <label class="cut-export-label">Recent Messages (%)</label>
          <input type="number" class="cut-export-input" id="cut-export-percent" min="1" max="100" value="100">
        </div>
        <div class="cut-export-group">
          <label class="cut-export-label">Format</label>
          <select class="cut-export-select" id="cut-export-format">
            <option value="md">Markdown (.md)</option>
            <option value="txt">Plain Text (.txt)</option>
            <option value="json">JSON (.json)</option>
          </select>
        </div>
        <div class="cut-export-actions">
          <button class="cut-export-btn cut-export-btn-cancel" id="cut-export-cancel">Cancel</button>
          <button class="cut-export-btn cut-export-btn-confirm" id="cut-export-confirm">Export</button>
        </div>
      </div>
    `;

    container.appendChild(overlay);

    // Trigger animations
    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      overlay.querySelector('.cut-export-modal')?.classList.add('show');
    });

    const close = (result: { percentage: number; format: 'md' | 'txt' | 'json' } | null) => {
      overlay.style.opacity = '0';
      overlay.querySelector('.cut-export-modal')?.classList.remove('show');
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }, 200);
    };

    overlay.querySelector('#cut-export-cancel')?.addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });

    overlay.querySelector('#cut-export-confirm')?.addEventListener('click', () => {
      const percentInput = overlay.querySelector('#cut-export-percent') as HTMLInputElement;
      const formatSelect = overlay.querySelector('#cut-export-format') as HTMLSelectElement;
      
      const percent = parseInt(percentInput.value, 10);
      if (isNaN(percent) || percent <= 0 || percent > 100) {
        alert("Please enter a valid percentage between 1 and 100.");
        return;
      }

      close({ percentage: percent, format: formatSelect.value as 'md' | 'txt' | 'json' });
    });
  });
}
