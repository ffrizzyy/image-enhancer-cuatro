import { useRef, useState, type DragEvent } from 'react';

interface DropZoneProps {
  onFile: (file: File) => void;
  disabled?: boolean;
}

/** Drag-and-drop target plus a keyboard-operable picker. Batch import is out of scope: first file wins. */
export function DropZone({ onFile, disabled = false }: DropZoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file && !disabled) onFile(file);
  };

  return (
    <div
      data-testid="dropzone"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`rounded-lg border-2 border-dashed p-10 text-center ${
        dragging ? 'border-blue-600 bg-blue-50' : 'border-slate-300'
      }`}
    >
      <p className="mb-4">Drag an image here, or choose one from your computer.</p>
      <p className="mb-4 text-sm text-slate-600">PNG, JPEG or WebP, up to 50 MB and 8192 px per side.</p>
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        Choose image…
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        aria-label="Image file"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = '';
        }}
      />
    </div>
  );
}
