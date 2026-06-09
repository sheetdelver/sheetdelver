'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
// import Underline from '@tiptap/extension-underline';
// import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { useEffect, useState, useMemo } from 'react';

export interface RichTextTheme {
    container: string;
    toolbar: {
        container: string;
        button: string;
        buttonActive: string;
        separator: string;
        actionButton: string;
        saveButton: string;
    };
    editor: string;
    editButton: string;
}

export const DASHBOARD_THEME: RichTextTheme = {
    container: 'relative group h-full flex flex-col bg-neutral-950/50 border border-neutral-800 rounded-lg overflow-hidden',
    toolbar: {
        container: 'bg-neutral-900 border-b border-neutral-800 p-2 flex flex-wrap gap-1 items-center sticky top-0 z-10',
        button: 'p-2 rounded-md hover:bg-neutral-800 transition-colors text-neutral-400 hover:text-white',
        buttonActive: 'p-2 rounded-md bg-neutral-800 text-white',
        separator: 'w-px h-6 bg-neutral-800 mx-1',
        actionButton: 'px-3 py-1 text-xs font-medium text-neutral-400 hover:text-white hover:bg-neutral-800 rounded-md mr-2',
        saveButton: 'px-3 py-1 text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 rounded-md flex items-center gap-1 shadow-sm'
    },
    editor: 'prose prose-invert prose-sm max-w-none focus:outline-none min-h-[300px] p-4 font-sans',
    editButton: 'bg-neutral-800 text-neutral-200 px-4 py-2 text-sm font-medium rounded-md hover:bg-neutral-700 hover:text-white transition-colors flex items-center gap-2 shadow-sm border border-neutral-700/50 backdrop-blur-sm'
};

interface RichTextEditorProps {
    content: string;
    onSave: (html: string) => void;
    editButtonText?: string;
    theme?: RichTextTheme;
}

const ToolbarButton = ({ onClick, isActive, children, title, theme }: any) => (
    <button
        onClick={onClick}
        title={title}
        className={isActive ? theme.toolbar.buttonActive : theme.toolbar.button}
    >
        {children}
    </button>
);

export default function RichTextEditor({
    content,
    onSave,
    editButtonText = 'Edit Note',
    theme = DASHBOARD_THEME
}: RichTextEditorProps) {
    const [isEditing, setIsEditing] = useState(false);

    const extensions = useMemo(() => [
        StarterKit,
        // Underline, // Causing duplicate warning
        // Link.configure({ // Causing duplicate warning
        //     openOnClick: false,
        // }),
        Image,
        TextAlign.configure({
            types: ['heading', 'paragraph'],
        }),
    ], []);

    const editor = useEditor({
        extensions,
        content: content,
        editable: isEditing,
        editorProps: {
            attributes: {
                class: theme.editor,
            },
        },
        immediatelyRender: false,
    }, [extensions, theme]); // Re-create editor if theme changes to update classes

    // Update content if prop changes externally
    useEffect(() => {
        if (editor && content !== editor.getHTML()) {
            editor.commands.setContent(content);
        }
    }, [content, editor]);

    // Update editable state
    useEffect(() => {
        if (editor) {
            editor.setEditable(isEditing);
        }
    }, [isEditing, editor]);

    if (!editor) {
        return null;
    }

    const handleSave = () => {
        onSave(editor.getHTML());
        setIsEditing(false);
    };

    const handleCancel = () => {
        editor.commands.setContent(content);
        setIsEditing(false);
    };

    return (
        <div className={theme.container}>
            {/* Toolbar - Only visible when editing */}
            {isEditing && (
                <div className={theme.toolbar.container}>
                    <ToolbarButton
                        onClick={() => editor.chain().focus().toggleBold().run()}
                        isActive={editor.isActive('bold')}
                        title="Bold"
                        theme={theme}
                    >
                        <strong className="font-serif">B</strong>
                    </ToolbarButton>
                    <ToolbarButton
                        onClick={() => editor.chain().focus().toggleItalic().run()}
                        isActive={editor.isActive('italic')}
                        title="Italic"
                        theme={theme}
                    >
                        <em className="font-serif">I</em>
                    </ToolbarButton>
                    <ToolbarButton
                        onClick={() => editor.chain().focus().toggleUnderline().run()}
                        isActive={editor.isActive('underline')}
                        title="Underline"
                        theme={theme}
                    >
                        <span className="underline font-serif">U</span>
                    </ToolbarButton>

                    <div className={theme.toolbar.separator}></div>

                    <ToolbarButton
                        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                        isActive={editor.isActive('heading', { level: 1 })}
                        title="H1"
                        theme={theme}
                    >
                        H1
                    </ToolbarButton>
                    <ToolbarButton
                        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                        isActive={editor.isActive('heading', { level: 2 })}
                        title="H2"
                        theme={theme}
                    >
                        H2
                    </ToolbarButton>

                    <div className={theme.toolbar.separator}></div>

                    <ToolbarButton
                        onClick={() => editor.chain().focus().toggleBulletList().run()}
                        isActive={editor.isActive('bulletList')}
                        title="Bullet List"
                        theme={theme}
                    >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 6h13v2H8V6zm0 5h13v2H8v-2zm0 5h13v2H8v-2zM4 6h2v2H4V6zm0 5h2v2H4v-2zm0 5h2v2H4v-2z" /></svg>
                    </ToolbarButton>
                    <ToolbarButton
                        onClick={() => editor.chain().focus().toggleOrderedList().run()}
                        isActive={editor.isActive('orderedList')}
                        title="Ordered List"
                        theme={theme}
                    >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M7 6h14v2H7V6zm0 5h14v2H7v-2zm0 5h14v2H7v-2zM3 6h2v2H3V6zm0 5h2v2H3v-2zm0 5h2v2H3v-2z" /></svg>
                    </ToolbarButton>

                    <div className={theme.toolbar.separator}></div>

                    <ToolbarButton
                        onClick={() => editor.chain().focus().setHorizontalRule().run()}
                        title="Horizontal Rule"
                        theme={theme}
                    >
                        —
                    </ToolbarButton>

                    <div className="flex-1"></div>

                    {/* Action Buttons */}
                    <button
                        onClick={handleCancel}
                        className={theme.toolbar.actionButton}
                    >
                        Close
                    </button>
                    <button
                        onClick={handleSave}
                        className={theme.toolbar.saveButton}
                    >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" /></svg>
                        Save
                    </button>
                </div>
            )}

            {/* Editor Content */}
            <div className={`flex-1 overflow-y-auto scrollbar-hide ${!isEditing ? 'cursor-default' : 'bg-white/5'}`}>
                <EditorContent editor={editor} className="h-full" />
            </div>

            {/* Edit Button - Visible when not editing */}
            {!isEditing && (
                <div className="p-4 z-10 w-full flex justify-center lg:justify-end">
                    <button
                        onClick={() => setIsEditing(true)}
                        className={`w-full lg:w-auto justify-center ${theme.editButton}`}
                    >
                        {editButtonText}
                    </button>
                </div>
            )}
        </div>
    );
}
