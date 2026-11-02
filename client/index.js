// LAN Sync: two Project Σ installs (a phone and a desktop) paired by QR code and kept in step over the
// network, after TauriTavern's LAN Sync. The page is the Sync panel; the server half does the syncing.
import { createPanel } from './panel.js';
import { PAIR_PARAM } from './pair-link.js';

export default {
    async init(ctx) {
        const panel = createPanel(ctx);

        ctx.ui.addAction('app', {
            id: 'open',
            label: 'LAN Sync',
            icon: 'fa-arrows-rotate',
            run: () => panel.open(),
        });

        ctx.ui.addAction('character', {
            id: 'merge-duplicate',
            label: 'Merge Duplicate Into...',
            icon: 'fa-code-merge',
            run: ({ character }) => panel.openMergeDuplicate({ character }),
        });

        ctx.ui.addSettingsSection((el) => panel.renderSettings(el));

        // a pairing link opened in this Σ (a phone's camera hands it here): open the panel on it
        const params = new URLSearchParams(location.search);
        const payload = params.get(PAIR_PARAM);
        if (payload) {
            params.delete(PAIR_PARAM);
            const rest = params.toString();
            history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
            panel.open({ joinLink: `?${PAIR_PARAM}=${payload}` });
        }
    },
};
