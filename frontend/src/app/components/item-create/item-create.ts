import { Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';

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
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';
import { prepareImageForUpload } from '../../shared/image-utils';
import { HtmlEditor } from '../html-editor/html-editor';

type ItemType = 'essen' | 'getränk';
type OrderInputType = 'string' | 'select' | 'boolean';

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
  description_html?: string | null;
  price_eur?: number | null;
  order_attributes?: Array<{
    key: string;
    label: string;
    input_type: OrderInputType;
    required: boolean;
    options: string[];
  }>;
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
    HtmlEditor
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
  @ViewChild('captureVideo') captureVideo?: ElementRef<HTMLVideoElement>;

  private zxingNamespace: any = null;
  private zxingReader: any = null;
  private zxingControls: { stop: () => void } | null = null;
  private photoStream: MediaStream | null = null;

  saving = signal(false);
  selectedFiles = signal<File[]>([]);
  imageUrlDraft = signal('');
  imageUrls = signal<string[]>([]);
  photoCameraActive = signal(false);
  photoCameraLoading = signal(false);

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

  orderAttributeRows = signal<OrderAttributeRow[]>([
    { key: '', label: '', input_type: 'string', required: false, options_text: '' },
  ]);

  form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    item_type: new FormControl<ItemType>('essen', { nonNullable: true }),
    description_html: new FormControl<string>(''),
    price_eur: new FormControl<number | null>(null),
    quantity: new FormControl<number | null>(null),
    unit: new FormControl<string>(''),
    ean: new FormControl<string>(''),
  });

  ngOnDestroy(): void {
    this.stopPhotoCamera();
    this.stopScanner();
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

  onCameraCapture(event: Event): void {
    const target = event.target as HTMLInputElement;
    const files = target.files ? Array.from(target.files) : [];
    if (files.length === 0) return;

    this.selectedFiles.update((current) => [...current, ...files]);
    this.snackBar.open('Foto erfasst und zur Upload-Liste hinzugefügt.', 'OK', { duration: 1800 });
    target.value = '';
  }

  async openPhotoCamera(fallbackInput: HTMLInputElement): Promise<void> {
    if (this.photoCameraActive()) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      fallbackInput.click();
      return;
    }

    try {
      this.photoCameraLoading.set(true);
      this.photoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      this.photoCameraActive.set(true);

      setTimeout(async () => {
        const video = this.captureVideo?.nativeElement;
        if (!video || !this.photoStream) return;

        video.srcObject = this.photoStream;
        try {
          await video.play();
        } catch {
          // ignore autoplay errors
        }
      });
    } catch {
      this.stopPhotoCamera();
      fallbackInput.click();
      this.snackBar.open('Webcam konnte nicht gestartet werden. Datei-Dialog wird verwendet.', 'OK', { duration: 2800 });
    } finally {
      this.photoCameraLoading.set(false);
    }
  }

  stopPhotoCamera(): void {
    this.photoCameraActive.set(false);
    this.photoCameraLoading.set(false);

    if (this.photoStream) {
      this.photoStream.getTracks().forEach((track) => track.stop());
      this.photoStream = null;
    }

    const video = this.captureVideo?.nativeElement;
    if (video) {
      video.srcObject = null;
    }
  }

  async takePhotoFromCamera(): Promise<void> {
    const video = this.captureVideo?.nativeElement;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      this.snackBar.open('Kamerabild ist noch nicht bereit.', 'OK', { duration: 2000 });
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.snackBar.open('Fotoaufnahme fehlgeschlagen.', 'OK', { duration: 2200 });
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) {
      this.snackBar.open('Foto konnte nicht erstellt werden.', 'OK', { duration: 2200 });
      return;
    }

    const file = new File([blob], `camera-${Date.now()}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });
    this.selectedFiles.update((current) => [...current, file]);
    this.stopPhotoCamera();
    this.snackBar.open('Foto erfasst und zur Upload-Liste hinzugefügt.', 'OK', { duration: 1800 });
  }

  removeSelectedFile(index: number): void {
    this.selectedFiles.update((files) => {
      const clone = [...files];
      clone.splice(index, 1);
      return clone;
    });
  }

  setImageUrl(value: string): void {
    this.imageUrlDraft.set(value);
  }

  addImageUrl(): void {
    const url = this.imageUrlDraft().trim();
    if (!url) return;

    this.imageUrls.update((list) => [...list, url]);
    this.imageUrlDraft.set('');
  }

  removeImageUrl(index: number): void {
    this.imageUrls.update((list) => {
      const clone = [...list];
      clone.splice(index, 1);
      return clone;
    });
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
    this.form.patchValue({
      name: metadata.name || this.form.controls.name.value,
      item_type: metadata.item_type || 'essen',
      ean,
    });

    this.metadataSource.set(metadata.source || null);
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

      if (res?.item) {
        const updatedLookup: EanLookupResult = {
          ...lookup,
          item: res.item as Item,
          metadata_found: true,
          metadata: {
            source: 'local_db',
            name: res.item.name,
            item_type: res.item.item_type,
          },
        };
        this.eanLookupResult.set(updatedLookup);
      }
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

    const payload = this.buildPayload();
    if (!payload) {
      return;
    }

    this.saving.set(true);

    this.api.post('/api/items/', this.auth.token(), payload).subscribe(async (res: any) => {
      if (this.isApiError(res)) {
        this.saving.set(false);
        this.snackBar.open('Item konnte nicht erstellt werden (evtl. EAN doppelt).', 'OK', { duration: 3000 });
        return;
      }

      const createdId = res.id;
      await this.attachImagesAfterCreate(createdId);
      this.saving.set(false);
      this.snackBar.open('Item erstellt.', 'OK', { duration: 2200 });
      this.router.navigate(['/items/list']);
    });
  }

  resetForm(): void {
    this.form.reset({
      name: '',
      item_type: 'essen',
      description_html: '',
      price_eur: null,
      quantity: null,
      unit: '',
      ean: '',
    });
    this.orderAttributeRows.set([{ key: '', label: '', input_type: 'string', required: false, options_text: '' }]);
    this.selectedFiles.set([]);
    this.imageUrlDraft.set('');
    this.imageUrls.set([]);
    this.eanInput.set('');
    this.eanLookupResult.set(null);
    this.metadataSource.set(null);
  }

  private async attachImagesAfterCreate(itemId: string): Promise<void> {
    const files = this.selectedFiles();
    const urls = this.imageUrls();

    for (const file of files) {
      const optimizedFile = await prepareImageForUpload(file);
      const formData = new FormData();
      formData.append('file', optimizedFile, optimizedFile.name);

      const uploadRes = await firstValueFrom(this.api.upload(`/api/items/${itemId}/image/`, this.auth.token(), formData));
      if (this.isApiError(uploadRes)) {
        this.snackBar.open(`Bild-Upload fehlgeschlagen: ${file.name}`, 'OK', { duration: 3200 });
      }
    }

    for (const url of urls) {
      const urlRes = await firstValueFrom(
        this.api.post(`/api/items/${itemId}/image/from-url/`, this.auth.token(), { url })
      );
      if (this.isApiError(urlRes)) {
        this.snackBar.open(`Bild-URL konnte nicht übernommen werden: ${url}`, 'OK', { duration: 3200 });
      }
    }
  }

  private buildPayload(): any | null {
    const orderAttributes: Array<{
      key: string;
      label: string;
      input_type: OrderInputType;
      required: boolean;
      options: string[];
    }> = [];

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
    const priceValue = this.parsePrice(this.form.controls.price_eur.value);
    if (priceValue === undefined) {
      this.snackBar.open('Preis muss eine positive Zahl sein.', 'OK', { duration: 2600 });
      return null;
    }

    return {
      name: this.form.controls.name.value.trim(),
      item_type: this.form.controls.item_type.value,
      description_html: this.normalizeDescriptionHtml(this.form.controls.description_html.value),
      order_attributes: orderAttributes,
      price_eur: priceValue,
      quantity: this.form.controls.quantity.value,
      unit: (this.form.controls.unit.value || '').trim() || null,
      ean: ean || null,
      metadata_source: this.metadataSource() || null,
    };
  }

  private parsePrice(value: number | null): number | null | undefined {
    if (value === null || value === undefined) {
      return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return undefined;
    }

    return Math.round(parsed * 100) / 100;
  }

  private normalizeDescriptionHtml(value: string | null | undefined): string | null {
    const html = (value || '').trim();
    if (!html) return null;

    const textOnly = html.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
    return textOnly ? html : null;
  }

  private isApiError(response: any): boolean {
    return Array.isArray(response) && response.length > 0 && response[0]?.error_code !== undefined;
  }
}
