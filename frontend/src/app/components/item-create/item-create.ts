import { Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { Router, RouterModule } from '@angular/router';

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
}

interface EanMetadata {
  source?: string;
  name?: string;
  brand?: string;
  item_type?: ItemType;
  quantity?: string | null;
  category?: string;
  attributes?: Record<string, any>;
}

interface EanLookupResult {
  ean: string;
  known: boolean;
  action: 'increase_stock' | 'create_item';
  item: Item | null;
  metadata_found: boolean;
  metadata: EanMetadata | null;
  providers_queried: string[];
}

@Component({
  selector: 'app-item-create',
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
  templateUrl: './item-create.html',
  styleUrls: ['./item-create.css'],
})
export class ItemCreate implements OnDestroy {
  private static zxingLoadPromise: Promise<any> | null = null;

  private api = inject(ApiService);
  private auth = inject(AuthService);
  private snackBar = inject(MatSnackBar);
  private router = inject(Router);

  @ViewChild('eanVideo') eanVideo?: ElementRef<HTMLVideoElement>;

  private zxingNamespace: any = null;
  private zxingReader: any = null;
  private zxingControls: { stop: () => void } | null = null;

  saving = signal(false);
  selectedFile = signal<File | null>(null);
  imageUrl = signal('');

  scannerSupported = signal<boolean>(
    typeof window !== 'undefined' &&
      !!navigator.mediaDevices &&
      !!navigator.mediaDevices.getUserMedia
  );
  scannerLoading = signal(false);
  scannerActive = signal(false);
  eanLookupLoading = signal(false);
  eanLookupResult = signal<EanLookupResult | null>(null);
  eanInput = signal('');
  stockIncrease = signal(1);
  metadataSource = signal<string | null>(null);

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

  ngOnDestroy(): void {
    this.stopScanner();
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
    const file = target.files && target.files.length > 0 ? target.files[0] : null;
    this.selectedFile.set(file);
  }

  clearFileSelection(input: HTMLInputElement): void {
    this.selectedFile.set(null);
    input.value = '';
  }

  setImageUrl(value: string): void {
    this.imageUrl.set(value);
  }

  setEanInput(value: string): void {
    this.eanInput.set(value);
    this.form.controls.ean.setValue(value);
  }

  setStockIncrease(value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.stockIncrease.set(1);
      return;
    }
    this.stockIncrease.set(parsed);
  }

  async toggleScanner(): Promise<void> {
    if (this.scannerActive()) {
      this.stopScanner();
      return;
    }

    await this.startScanner();
  }

  private async startScanner(): Promise<void> {
    if (!this.scannerSupported()) {
      this.snackBar.open('Barcode-Scanner wird im aktuellen Browser nicht unterstützt.', 'OK', { duration: 3000 });
      return;
    }

    try {
      this.scannerLoading.set(true);
      await this.ensureZxingLoaded();
      this.scannerLoading.set(false);
      this.scannerActive.set(true);
      await this.startZxingDecoding();
    } catch {
      this.scannerLoading.set(false);
      this.stopScanner();
      this.snackBar.open('Scanner konnte nicht gestartet werden. Bitte EAN manuell eingeben.', 'OK', { duration: 3200 });
    }
  }

  private async ensureZxingLoaded(): Promise<void> {
    if (this.zxingNamespace) {
      return;
    }

    const win = window as any;
    if (win.ZXingBrowser) {
      this.zxingNamespace = win.ZXingBrowser;
      return;
    }

    if (!ItemCreate.zxingLoadPromise) {
      ItemCreate.zxingLoadPromise = new Promise((resolve, reject) => {
        const existing = document.getElementById('zxing-browser-script') as HTMLScriptElement | null;
        if (existing) {
          existing.addEventListener('load', () => resolve((window as any).ZXingBrowser));
          existing.addEventListener('error', () => reject(new Error('ZXing script load failed')));
          return;
        }

        const script = document.createElement('script');
        script.id = 'zxing-browser-script';
        script.src = 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js';
        script.async = true;
        script.defer = true;
        script.onload = () => resolve((window as any).ZXingBrowser);
        script.onerror = () => reject(new Error('ZXing script load failed'));
        document.head.appendChild(script);
      });
    }

    try {
      this.zxingNamespace = await ItemCreate.zxingLoadPromise;
    } catch (error) {
      ItemCreate.zxingLoadPromise = null;
      throw error;
    }

    if (!this.zxingNamespace) {
      throw new Error('ZXing not available');
    }
  }

  private async startZxingDecoding(): Promise<void> {
    const video = this.eanVideo?.nativeElement;
    if (!video || !this.zxingNamespace) {
      throw new Error('Video or ZXing missing');
    }

    this.zxingReader = new this.zxingNamespace.BrowserMultiFormatReader();

    const callback = (result: any) => {
      const text = this.extractScanText(result);
      if (!text) return;
      this.onBarcodeDetected(text);
    };

    if (typeof this.zxingReader.decodeFromConstraints === 'function') {
      this.zxingControls = await this.zxingReader.decodeFromConstraints(
        {
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        },
        video,
        callback
      );
      return;
    }

    if (typeof this.zxingReader.decodeFromVideoDevice === 'function') {
      this.zxingControls = await this.zxingReader.decodeFromVideoDevice(undefined, video, callback);
      return;
    }

    throw new Error('Unsupported ZXing API');
  }

  private extractScanText(result: any): string {
    if (!result) return '';

    if (typeof result.getText === 'function') {
      const value = result.getText();
      return typeof value === 'string' ? value.trim() : '';
    }

    if (typeof result.text === 'string') {
      return result.text.trim();
    }

    return '';
  }

  private stopScanner(): void {
    this.scannerActive.set(false);
    this.scannerLoading.set(false);

    if (this.zxingControls) {
      try {
        this.zxingControls.stop();
      } catch {
        // ignore scanner stop errors
      }
      this.zxingControls = null;
    }

    if (this.zxingReader && typeof this.zxingReader.reset === 'function') {
      try {
        this.zxingReader.reset();
      } catch {
        // ignore scanner reset errors
      }
    }
    this.zxingReader = null;

    const video = this.eanVideo?.nativeElement;
    if (video) {
      video.srcObject = null;
    }
  }

  private onBarcodeDetected(value: string): void {
    this.stopScanner();
    this.setEanInput(value);

    // EAN lookup expects numeric codes (8-14 digits). Other barcodes are still shown to the user.
    const numericOnly = value.replace(/\D/g, '');
    if (numericOnly.length >= 8 && numericOnly.length <= 14) {
      this.setEanInput(numericOnly);
      this.lookupEan();
      return;
    }

    this.snackBar.open('Code erkannt. Bitte EAN prüfen oder manuell eingeben.', 'OK', { duration: 3000 });
  }

  lookupEan(): void {
    const ean = this.eanInput().trim();
    if (!ean) {
      this.snackBar.open('Bitte EAN eingeben oder scannen.', 'OK', { duration: 2200 });
      return;
    }

    this.eanLookupLoading.set(true);
    this.eanLookupResult.set(null);

    this.api.get(`/api/items/ean/${encodeURIComponent(ean)}/lookup/`, this.auth.token()).subscribe((res: any) => {
      this.eanLookupLoading.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('EAN-Suche fehlgeschlagen.', 'OK', { duration: 2500 });
        return;
      }

      const result = res as EanLookupResult;
      this.eanLookupResult.set(result);
      this.form.controls.ean.setValue(result.ean);

      if (result.known) {
        this.metadataSource.set('local_db');
        this.stockIncrease.set(1);
        this.snackBar.open('EAN bekannt. Lagerbestand kann direkt erhöht werden.', 'OK', { duration: 2500 });
        return;
      }

      if (result.metadata_found && result.metadata) {
        this.prefillFromMetadata(result.ean, result.metadata);
        this.snackBar.open('Metadaten gefunden. Formular wurde vorausgefüllt.', 'OK', { duration: 3000 });
        return;
      }

      this.metadataSource.set(null);
      this.snackBar.open('Kein API-Treffer. Bitte Daten manuell eintragen.', 'OK', { duration: 3000 });
    });
  }

  private prefillFromMetadata(ean: string, metadata: EanMetadata): void {
    const mergedAttrs: Record<string, any> = { ...(metadata.attributes || {}) };

    if (metadata.brand && !mergedAttrs['marke']) {
      mergedAttrs['marke'] = metadata.brand;
    }

    if (metadata.category && !mergedAttrs['kategorie']) {
      mergedAttrs['kategorie'] = metadata.category;
    }

    if (metadata.quantity && !mergedAttrs['verpackung']) {
      mergedAttrs['verpackung'] = metadata.quantity;
    }

    this.form.patchValue({
      name: metadata.name || this.form.controls.name.value,
      item_type: metadata.item_type || 'essen',
      ean,
    });

    this.metadataSource.set(metadata.source || null);

    const rows = Object.entries(mergedAttrs).map(([key, value]) => ({
      key,
      value: this.stringifyValue(value),
    }));

    if (rows.length > 0) {
      this.attributeRows.set(rows);
    }
  }

  increaseStockForKnownEan(): void {
    const lookup = this.eanLookupResult();
    if (!lookup || !lookup.known) return;

    this.api.post('/api/items/ean/stock-increase/', this.auth.token(), {
      ean: lookup.ean,
      quantity_delta: this.stockIncrease(),
    }).subscribe((res: any) => {
      if (this.isApiError(res)) {
        this.snackBar.open('Bestand konnte nicht erhöht werden.', 'OK', { duration: 2500 });
        return;
      }

      this.snackBar.open('Lagerbestand wurde erhöht.', 'OK', { duration: 2200 });
    });
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    if (this.eanLookupResult()?.known) {
      this.snackBar.open('EAN existiert bereits. Bitte Lagerbestand erhöhen statt neu anlegen.', 'OK', { duration: 3000 });
      return;
    }

    const file = this.selectedFile();
    const imageUrl = this.imageUrl().trim();
    if (file && imageUrl) {
      this.snackBar.open('Bitte entweder Datei-Upload oder Bild-URL verwenden.', 'OK', { duration: 3000 });
      return;
    }

    const payload = this.buildPayload();
    if (!payload) {
      return;
    }

    this.saving.set(true);

    this.api.post('/api/items/', this.auth.token(), payload).subscribe((res: any) => {
      if (this.isApiError(res)) {
        this.saving.set(false);
        this.snackBar.open('Item konnte nicht erstellt werden (evtl. EAN doppelt).', 'OK', { duration: 3000 });
        return;
      }

      const createdId = res.id;
      this.attachImageAfterCreate(createdId, file, imageUrl);
    });
  }

  resetForm(): void {
    this.form.reset({
      name: '',
      item_type: 'essen',
      in_stock: true,
      quantity: null,
      unit: '',
      ean: '',
    });
    this.attributeRows.set([{ key: '', value: '' }]);
    this.orderAttributeRows.set([{ key: '', label: '', input_type: 'string', required: false, options_text: '' }]);
    this.selectedFile.set(null);
    this.imageUrl.set('');
    this.eanInput.set('');
    this.eanLookupResult.set(null);
    this.metadataSource.set(null);
  }

  private attachImageAfterCreate(itemId: string, file: File | null, imageUrl: string): void {
    if (!file && !imageUrl) {
      this.saving.set(false);
      this.snackBar.open('Item erstellt.', 'OK', { duration: 2200 });
      this.router.navigate(['/items/list']);
      return;
    }

    if (file) {
      const formData = new FormData();
      formData.append('file', file);

      this.api.upload(`/api/items/${itemId}/image/`, this.auth.token(), formData).subscribe((imgRes: any) => {
        this.saving.set(false);

        if (this.isApiError(imgRes)) {
          this.snackBar.open('Item erstellt, Bild-Upload fehlgeschlagen.', 'OK', { duration: 3000 });
          this.router.navigate(['/items/list']);
          return;
        }

        this.snackBar.open('Item inklusive Bild erstellt.', 'OK', { duration: 2200 });
        this.router.navigate(['/items/list']);
      });
      return;
    }

    this.api.post(`/api/items/${itemId}/image/from-url/`, this.auth.token(), { url: imageUrl }).subscribe((imgRes: any) => {
      this.saving.set(false);

      if (this.isApiError(imgRes)) {
        this.snackBar.open('Item erstellt, Bild-URL konnte nicht übernommen werden.', 'OK', { duration: 3200 });
        this.router.navigate(['/items/list']);
        return;
      }

      this.snackBar.open('Item inklusive Bild erstellt.', 'OK', { duration: 2200 });
      this.router.navigate(['/items/list']);
    });
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
      metadata_source: this.metadataSource() || null,
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
