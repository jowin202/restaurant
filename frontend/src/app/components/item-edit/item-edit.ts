import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';

type ItemType = 'essen' | 'getränk';
type OrderInputType = 'string' | 'select' | 'boolean';

interface AttributeRow {
  key: string;
  value: string;
}

interface OrderAttributeRow {
  key: string;
  label: string;
  input_type: OrderInputType;
  required: boolean;
  options_text: string;
}

interface Item {
  id: string;
  name: string;
  item_type: ItemType;
  attributes: Record<string, any>;
  order_attributes?: Array<{
    key: string;
    label: string;
    input_type: OrderInputType;
    required: boolean;
    options: string[];
  }>;
  in_stock: boolean;
  quantity: number | null;
  unit: string | null;
  ean?: string | null;
  has_image: boolean;
  image_data_url?: string | null;
  image_data_urls?: string[];
  images?: Array<{ id: string; filename?: string; content_type?: string }>;
}

@Component({
  selector: 'app-item-edit',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatSlideToggleModule,
    MatSnackBarModule,
  ],
  templateUrl: './item-edit.html',
  styleUrls: ['./item-edit.css'],
})
export class ItemEdit implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private snackBar = inject(MatSnackBar);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  itemId = '';
  loading = signal(true);
  saving = signal(false);
  imageBusy = signal(false);

  selectedFiles = signal<File[]>([]);
  imageUrlDraft = signal('');
  currentImageDataUrls = signal<string[]>([]);
  imageMetas = signal<Array<{ id: string; filename?: string; content_type?: string }>>([]);

  attributeRows = signal<AttributeRow[]>([{ key: '', value: '' }]);
  orderAttributeRows = signal<OrderAttributeRow[]>([
    { key: '', label: '', input_type: 'string', required: false, options_text: '' },
  ]);

  form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    item_type: new FormControl<ItemType>('essen', { nonNullable: true }),
    in_stock: new FormControl(true, { nonNullable: true }),
    quantity: new FormControl<number | null>(null),
    unit: new FormControl<string>(''),
    ean: new FormControl<string>(''),
  });

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.router.navigate(['/items/list']);
      return;
    }

    this.itemId = id;
    this.loadItem();
  }

  trackByIndex(index: number): number {
    return index;
  }

  addAttributeRow(): void {
    this.attributeRows.update((rows) => [...rows, { key: '', value: '' }]);
  }

  removeAttributeRow(index: number): void {
    this.attributeRows.update((rows) => {
      const clone = [...rows];
      clone.splice(index, 1);
      return clone.length > 0 ? clone : [{ key: '', value: '' }];
    });
  }

  onAttributeKeyChange(index: number, value: string): void {
    this.attributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], key: value };
      return clone;
    });
  }

  onAttributeValueChange(index: number, value: string): void {
    this.attributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], value };
      return clone;
    });
  }

  addOrderAttributeRow(): void {
    this.orderAttributeRows.update((rows) => [
      ...rows,
      { key: '', label: '', input_type: 'string', required: false, options_text: '' },
    ]);
  }

  removeOrderAttributeRow(index: number): void {
    this.orderAttributeRows.update((rows) => {
      const clone = [...rows];
      clone.splice(index, 1);
      return clone.length > 0
        ? clone
        : [{ key: '', label: '', input_type: 'string', required: false, options_text: '' }];
    });
  }

  onOrderAttributeKeyChange(index: number, value: string): void {
    this.orderAttributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], key: value };
      return clone;
    });
  }

  onOrderAttributeLabelChange(index: number, value: string): void {
    this.orderAttributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], label: value };
      return clone;
    });
  }

  onOrderAttributeTypeChange(index: number, value: OrderInputType): void {
    this.orderAttributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], input_type: value, options_text: value === 'select' ? clone[index].options_text : '' };
      return clone;
    });
  }

  onOrderAttributeRequiredChange(index: number, value: boolean): void {
    this.orderAttributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], required: value };
      return clone;
    });
  }

  onOrderAttributeOptionsChange(index: number, value: string): void {
    this.orderAttributeRows.update((rows) => {
      const clone = [...rows];
      clone[index] = { ...clone[index], options_text: value };
      return clone;
    });
  }

  onFileSelected(event: Event): void {
    const target = event.target as HTMLInputElement;
    const files = target.files ? Array.from(target.files) : [];
    if (files.length === 0) return;
    this.selectedFiles.update((current) => [...current, ...files]);
    target.value = '';
  }

  async onCameraCapture(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement;
    const files = target.files ? Array.from(target.files) : [];
    target.value = '';
    if (files.length === 0) return;

    this.imageBusy.set(true);
    let failed = 0;
    for (const file of files) {
      const ok = await this.uploadSingleFile(file);
      if (!ok) failed += 1;
    }
    this.imageBusy.set(false);
    this.loadItem();

    if (failed === 0) {
      this.snackBar.open('Foto wurde direkt hochgeladen.', 'OK', { duration: 2200 });
    } else {
      this.snackBar.open('Foto teilweise/gar nicht hochgeladen.', 'OK', { duration: 2800 });
    }
  }

  setImageUrl(value: string): void {
    this.imageUrlDraft.set(value);
  }

  removeSelectedFile(index: number): void {
    this.selectedFiles.update((files) => {
      const clone = [...files];
      clone.splice(index, 1);
      return clone;
    });
  }

  saveItem(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const payload = this.buildPayload();
    if (!payload) {
      return;
    }

    this.saving.set(true);
    this.api.put(`/api/items/${this.itemId}/`, this.auth.token(), payload).subscribe((res: any) => {
      this.saving.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('Item konnte nicht gespeichert werden.', 'OK', { duration: 3000 });
        return;
      }

      this.snackBar.open('Änderungen gespeichert.', 'OK', { duration: 2200 });
      this.loadItem();
    });
  }

  async uploadImages(): Promise<void> {
    const files = this.selectedFiles();
    if (files.length === 0) {
      this.snackBar.open('Bitte zuerst Dateien auswählen.', 'OK', { duration: 2200 });
      return;
    }

    this.imageBusy.set(true);
    let failed = 0;
    for (const file of files) {
      const ok = await this.uploadSingleFile(file);
      if (!ok) failed += 1;
    }
    this.imageBusy.set(false);
    this.selectedFiles.set([]);
    this.loadItem();

    if (failed === 0) {
      this.snackBar.open('Bilder wurden hochgeladen.', 'OK', { duration: 2200 });
    } else {
      this.snackBar.open('Einige Bilder konnten nicht hochgeladen werden.', 'OK', { duration: 3000 });
    }
  }

  importImageFromUrl(): void {
    const url = this.imageUrlDraft().trim();
    if (!url) {
      this.snackBar.open('Bitte eine Bild-URL eingeben.', 'OK', { duration: 2200 });
      return;
    }

    this.imageBusy.set(true);
    this.api.post(`/api/items/${this.itemId}/image/from-url/`, this.auth.token(), { url }).subscribe((res: any) => {
      this.imageBusy.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('Bild konnte nicht von URL übernommen werden.', 'OK', { duration: 3000 });
        return;
      }

      this.snackBar.open('Bild von URL übernommen.', 'OK', { duration: 2200 });
      this.imageUrlDraft.set('');
      this.loadItem();
    });
  }

  removeImage(imageId?: string): void {
    this.imageBusy.set(true);
    const url = imageId
      ? `/api/items/${this.itemId}/image/?image_id=${encodeURIComponent(imageId)}`
      : `/api/items/${this.itemId}/image/`;

    this.api.delete(url, this.auth.token()).subscribe((res: any) => {
      this.imageBusy.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('Bild konnte nicht entfernt werden.', 'OK', { duration: 2500 });
        return;
      }

      this.snackBar.open('Bild entfernt.', 'OK', { duration: 2200 });
      this.loadItem();
    });
  }

  private loadItem(): void {
    this.loading.set(true);
    this.api.get(`/api/items/${this.itemId}/?include_images=true`, this.auth.token()).subscribe((res: any) => {
      this.loading.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('Item konnte nicht geladen werden.', 'OK', { duration: 2800 });
        return;
      }

      const item = res as Item;
      this.form.patchValue({
        name: item.name,
        item_type: item.item_type,
        in_stock: item.in_stock,
        quantity: item.quantity,
        unit: item.unit || '',
        ean: item.ean || '',
      });

      const attrRows = Object.entries(item.attributes || {}).map(([key, value]) => ({
        key,
        value: this.stringifyValue(value),
      }));
      this.attributeRows.set(attrRows.length > 0 ? attrRows : [{ key: '', value: '' }]);

      const orderRows = (item.order_attributes || []).map((x) => ({
        key: x.key || '',
        label: x.label || x.key || '',
        input_type: x.input_type || 'string',
        required: !!x.required,
        options_text: Array.isArray(x.options) ? x.options.join(',') : '',
      }));
      this.orderAttributeRows.set(
        orderRows.length > 0
          ? orderRows
          : [{ key: '', label: '', input_type: 'string', required: false, options_text: '' }]
      );

      this.currentImageDataUrls.set(
        Array.isArray(item.image_data_urls) && item.image_data_urls.length > 0
          ? item.image_data_urls
          : item.image_data_url
            ? [item.image_data_url]
            : []
      );
      this.imageMetas.set(Array.isArray(item.images) ? item.images : []);
      this.selectedFiles.set([]);
      this.imageUrlDraft.set('');
    });
  }

  private async uploadSingleFile(file: File): Promise<boolean> {
    const formData = new FormData();
    formData.append('file', file);

    const res = await firstValueFrom(this.api.upload(`/api/items/${this.itemId}/image/`, this.auth.token(), formData));
    return !this.isApiError(res);
  }

  private buildPayload(): any | null {
    const attrs: Record<string, any> = {};
    const orderAttributes: Array<{
      key: string;
      label: string;
      input_type: OrderInputType;
      required: boolean;
      options: string[];
    }> = [];

    for (const row of this.attributeRows()) {
      const key = row.key.trim();
      if (!key) continue;
      attrs[key] = this.parseValue(row.value);
    }

    for (const row of this.orderAttributeRows()) {
      const key = row.key.trim();
      if (!key) continue;

      const label = row.label.trim() || key;
      const options =
        row.input_type === 'select'
          ? row.options_text
              .split(/[,\n;]+/)
              .map((x) => x.trim())
              .filter((x) => !!x)
          : [];

      if (row.input_type === 'select' && options.length < 2) {
        this.snackBar.open(`Bitte mindestens 2 Auswahlwerte für "${label}" angeben.`, 'OK', { duration: 3200 });
        return null;
      }

      orderAttributes.push({
        key,
        label,
        input_type: row.input_type,
        required: row.required,
        options,
      });
    }

    const ean = (this.form.controls.ean.value || '').trim();

    return {
      name: this.form.controls.name.value.trim(),
      item_type: this.form.controls.item_type.value,
      attributes: attrs,
      order_attributes: orderAttributes,
      in_stock: this.form.controls.in_stock.value,
      quantity: this.form.controls.quantity.value,
      unit: (this.form.controls.unit.value || '').trim() || null,
      ean: ean || null,
    };
  }

  private parseValue(raw: string): any {
    const value = (raw ?? '').trim();

    if (!value.length) return '';
    if (value === 'true') return true;
    if (value === 'false') return false;

    if (/^-?\d+(\.\d+)?$/.test(value)) {
      return Number(value);
    }

    if (value.startsWith('{') || value.startsWith('[') || value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }

    return value;
  }

  private stringifyValue(value: any): string {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  private isApiError(response: any): boolean {
    return Array.isArray(response) && response.length > 0 && response[0]?.error_code !== undefined;
  }
}
