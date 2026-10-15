import { Node } from '@tiptap/core';

/** Preserve Foundry's confidentiality wrapper when an owner edits rich text.
 * Attribute retention is deliberately limited to inert section metadata.
 */
export const JournalSecret = Node.create({
    name: 'journalSecret',
    group: 'block',
    content: 'block+',
    defining: true,
    addAttributes() {
        return {
            sectionAttributes: {
                default: { class: 'secret' },
                parseHTML: element => Object.fromEntries(Array.from(element.attributes)
                    .filter(attribute => ['id', 'class', 'title'].includes(attribute.name) || attribute.name.startsWith('data-'))
                    .map(attribute => [attribute.name, attribute.value])),
                renderHTML: attributes => attributes.sectionAttributes as Record<string, string>,
            },
        };
    },
    parseHTML: () => [{ tag: 'section.secret' }],
    renderHTML: ({ HTMLAttributes }) => ['section', HTMLAttributes, 0],
});
