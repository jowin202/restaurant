import { AfterViewInit, Component, ElementRef, forwardRef, Input, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-html-editor',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule],
  templateUrl: './html-editor.html',
  styleUrl: './html-editor.css',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => HtmlEditor),
      multi: true,
    },
  ],
})
export class HtmlEditor implements ControlValueAccessor, AfterViewInit {
  @ViewChild('editor') editorRef?: ElementRef<HTMLDivElement>;

  @Input() placeholder = 'Beschreibung eingeben...';
  @Input() minHeight = '180px';

  disabled = false;
  private value = '';

  private onChange: (value: string) => void = () => {};
  private onTouched: () => void = () => {};

  ngAfterViewInit(): void {
    this.syncEditorFromValue();
  }

  writeValue(value: string | null): void {
    this.value = typeof value === 'string' ? value : '';
    this.syncEditorFromValue();
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }

  onInput(): void {
    const html = this.editorRef?.nativeElement.innerHTML ?? '';
    this.value = html;
    this.onChange(html);
  }

  onBlur(): void {
    this.onTouched();
  }

  exec(command: string, value?: string): void {
    if (this.disabled) return;

    const editor = this.editorRef?.nativeElement;
    if (!editor) return;

    editor.focus();
    document.execCommand(command, false, value ?? undefined);
    this.onInput();
  }

  formatParagraph(): void {
    this.exec('formatBlock', 'P');
  }

  formatHeading(): void {
    this.exec('formatBlock', 'H3');
  }

  insertLink(): void {
    if (this.disabled) return;

    const link = window.prompt('Link-URL eingeben (https://...)');
    if (!link) return;

    const trimmed = link.trim();
    if (!trimmed) return;

    this.exec('createLink', trimmed);
  }

  clear(): void {
    if (this.disabled) return;

    const editor = this.editorRef?.nativeElement;
    if (!editor) return;

    editor.innerHTML = '';
    this.onInput();
  }

  private syncEditorFromValue(): void {
    const editor = this.editorRef?.nativeElement;
    if (!editor) return;

    if (editor.innerHTML !== this.value) {
      editor.innerHTML = this.value || '';
    }
  }
}
