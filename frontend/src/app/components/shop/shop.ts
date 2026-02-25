import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';
import {
  OrderAttributeDefinition,
  OrderAttributesDialog,
} from '../order-attributes-dialog/order-attributes-dialog';

type ItemType = 'essen' | 'getränk';

interface Item {
  id: string;
  name: string;
  item_type: ItemType;
  description_html?: string | null;
  quantity: number | null;
  unit: string | null;
  image_data_url?: string | null;
  image_data_urls?: string[];
  order_attributes?: OrderAttributeDefinition[];
}

interface CartLine {
  line_id: string;
  item: Item;
  quantity: number;
  order_answers: Record<string, any>;
}

@Component({
  selector: 'app-shop',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatIconModule,
    MatDialogModule,
    MatSnackBarModule,
  ],
  templateUrl: './shop.html',
  styleUrl: './shop.css',
})
export class Shop implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);

  loading = signal(true);
  ordering = signal(false);

  search = signal('');
  typeFilter = signal<'all' | ItemType>('all');
  orderComment = signal('');

  items = signal<Item[]>([]);
  cart = signal<CartLine[]>([]);

  visibleItems = computed(() => {
    const search = this.search().trim().toLowerCase();
    const type = this.typeFilter();

    return this.items().filter((item) => {
      if (type !== 'all' && item.item_type !== type) return false;
      if (!search) return true;
      return (
        item.name.toLowerCase().includes(search) ||
        this.stripHtml(item.description_html || '').toLowerCase().includes(search)
      );
    });
  });

  cartCount = computed(() => this.cart().reduce((sum, line) => sum + line.quantity, 0));
  private availabilityTimerId: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.reload();
    this.availabilityTimerId = setInterval(() => {
      this.reload(false);
    }, 30_000);
  }

  ngOnDestroy(): void {
    if (this.availabilityTimerId) {
      clearInterval(this.availabilityTimerId);
      this.availabilityTimerId = null;
    }
  }

  reload(showLoading: boolean = true): void {
    if (showLoading) {
      this.loading.set(true);
    }

    this.api.get('/api/items/?include_images=true&available=true', this.auth.token()).subscribe((res: any) => {
      if (showLoading) {
        this.loading.set(false);
      }

      if (this.isApiError(res)) {
        if (showLoading) {
          this.items.set([]);
          this.snackBar.open('Shop-Daten konnten nicht geladen werden.', 'OK', { duration: 2500 });
        }
        return;
      }

      this.items.set(res as Item[]);
      this.syncCartWithAvailability();
    });
  }

  setTypeFilter(value: 'all' | ItemType): void {
    this.typeFilter.set(value);
  }

  setSearch(value: string): void {
    this.search.set(value);
  }

  setOrderComment(value: string): void {
    this.orderComment.set(value);
  }

  addToCart(item: Item): void {
    if (!this.canIncreaseForItem(item, 1)) {
      this.showStockLimit(item);
      return;
    }

    const orderAttributes = this.getOrderAttributes(item);
    if (orderAttributes.length === 0) {
      this.upsertCartLine(item, {}, 1);
      return;
    }

    this.dialog
      .open(OrderAttributesDialog, {
        width: '460px',
        maxWidth: '92vw',
        data: {
          itemName: item.name,
          attributes: orderAttributes,
          initialAnswers: {},
        },
      })
      .afterClosed()
      .subscribe((answers: Record<string, any> | null | undefined) => {
        if (!answers) return;
        this.upsertCartLine(item, answers, 1);
      });
  }

  increment(line: CartLine): void {
    if (!this.canIncreaseForItem(line.item, 1)) {
      this.showStockLimit(line.item);
      return;
    }

    this.cart.update((current) =>
      current.map((x) => (x.line_id === line.line_id ? { ...x, quantity: x.quantity + 1 } : x))
    );
  }

  decrement(line: CartLine): void {
    this.cart.update((current) => {
      const next = current
        .map((x) => (x.line_id === line.line_id ? { ...x, quantity: x.quantity - 1 } : x))
        .filter((x) => x.quantity > 0);
      return next;
    });
  }

  remove(line: CartLine): void {
    this.cart.update((current) => current.filter((x) => x.line_id !== line.line_id));
  }

  editAnswers(line: CartLine): void {
    const orderAttributes = this.getOrderAttributes(line.item);
    if (orderAttributes.length === 0) {
      return;
    }

    this.dialog
      .open(OrderAttributesDialog, {
        width: '460px',
        maxWidth: '92vw',
        data: {
          itemName: line.item.name,
          attributes: orderAttributes,
          initialAnswers: line.order_answers,
        },
      })
      .afterClosed()
      .subscribe((answers: Record<string, any> | null | undefined) => {
        if (!answers) return;

        this.cart.update((current) => {
          const currentIndex = current.findIndex((x) => x.line_id === line.line_id);
          if (currentIndex < 0) return current;

          const signature = this.buildOrderAnswersSignature(answers);
          const mergeIndex = current.findIndex(
            (x, index) =>
              index !== currentIndex &&
              x.item.id === line.item.id &&
              this.buildOrderAnswersSignature(x.order_answers) === signature
          );

          if (mergeIndex < 0) {
            return current.map((x) => (x.line_id === line.line_id ? { ...x, order_answers: answers } : x));
          }

          const clone = [...current];
          clone[mergeIndex] = {
            ...clone[mergeIndex],
            quantity: clone[mergeIndex].quantity + clone[currentIndex].quantity,
          };
          clone.splice(currentIndex, 1);
          return clone;
        });
      });
  }

  lineAnswerEntries(line: CartLine): Array<{ label: string; value: string }> {
    const orderAttributes = this.getOrderAttributes(line.item);
    const answers = line.order_answers || {};
    const entries: Array<{ label: string; value: string }> = [];

    for (const attr of orderAttributes) {
      if (!(attr.key in answers)) continue;

      const value = answers[attr.key];
      if (attr.input_type !== 'boolean' && typeof value !== 'string') continue;
      if (attr.input_type !== 'boolean' && value.trim().length === 0) continue;

      entries.push({
        label: attr.label || attr.key,
        value: this.stringifyAnswer(value),
      });
    }

    for (const key of Object.keys(answers)) {
      if (orderAttributes.some((attr) => attr.key === key)) continue;
      entries.push({ label: key, value: this.stringifyAnswer(answers[key]) });
    }

    return entries;
  }

  orderNow(): void {
    if (this.cart().length === 0) {
      this.snackBar.open('Bitte zuerst Artikel auswählen.', 'OK', { duration: 2000 });
      return;
    }

    if (!this.ensureCartWithinStock()) {
      return;
    }

    const payload = {
      items: this.cart().map((line) => ({
        item_id: line.item.id,
        quantity: line.quantity,
        order_answers: line.order_answers,
      })),
      comment: this.orderComment().trim() || null,
    };

    this.ordering.set(true);
    this.api.post('/api/orders/checkout/', this.auth.token(), payload).subscribe((res: any) => {
      this.ordering.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('Bestellung fehlgeschlagen.', 'OK', { duration: 2500 });
        return;
      }

      this.cart.set([]);
      this.orderComment.set('');
      this.snackBar.open('Bestellung wurde ausgelöst.', 'OK', { duration: 2500 });
    });
  }

  primaryImage(item: Item): string | null {
    if (Array.isArray(item.image_data_urls) && item.image_data_urls.length > 0) {
      return item.image_data_urls[0] || null;
    }
    return item.image_data_url || null;
  }

  extraImageCount(item: Item): number {
    const count = Array.isArray(item.image_data_urls) ? item.image_data_urls.length : item.image_data_url ? 1 : 0;
    return Math.max(0, count - 1);
  }

  private isApiError(response: any): boolean {
    return Array.isArray(response) && response.length > 0 && response[0]?.error_code !== undefined;
  }

  private upsertCartLine(item: Item, orderAnswers: Record<string, any>, quantityDelta: number): void {
    if (!this.canIncreaseForItem(item, quantityDelta)) {
      this.showStockLimit(item);
      return;
    }

    this.cart.update((current) => {
      const signature = this.buildOrderAnswersSignature(orderAnswers);
      const index = current.findIndex(
        (line) =>
          line.item.id === item.id && this.buildOrderAnswersSignature(line.order_answers) === signature
      );
      if (index === -1) {
        return [
          ...current,
          {
            line_id: this.createCartLineId(),
            item,
            quantity: quantityDelta,
            order_answers: orderAnswers,
          },
        ];
      }

      const clone = [...current];
      clone[index] = {
        ...clone[index],
        quantity: clone[index].quantity + quantityDelta,
        order_answers: orderAnswers,
      };
      return clone;
    });
  }

  canIncrement(line: CartLine): boolean {
    return this.canIncreaseForItem(line.item, 1);
  }

  canAddToCart(item: Item): boolean {
    return this.canIncreaseForItem(item, 1);
  }

  private getOrderAttributes(item: Item): OrderAttributeDefinition[] {
    if (!Array.isArray(item.order_attributes)) {
      return [];
    }

    const seen = new Set<string>();
    const attributes: OrderAttributeDefinition[] = [];

    for (const row of item.order_attributes) {
      if (!row || typeof row !== 'object') continue;

      const key = String(row.key ?? '').trim();
      if (!key) continue;

      const lowered = key.toLowerCase();
      if (seen.has(lowered)) continue;

      const inputType = row.input_type;
      if (inputType !== 'string' && inputType !== 'select' && inputType !== 'boolean') continue;

      const options = Array.isArray(row.options)
        ? row.options.map((x) => String(x).trim()).filter((x) => x.length > 0)
        : [];

      attributes.push({
        key,
        label: String(row.label ?? '').trim() || key,
        input_type: inputType,
        required: Boolean(row.required),
        options: inputType === 'select' ? options : [],
      });
      seen.add(lowered);
    }

    return attributes;
  }

  private stringifyAnswer(value: any): string {
    if (typeof value === 'boolean') {
      return value ? 'Ja' : 'Nein';
    }
    return String(value);
  }

  private canIncreaseForItem(item: Item, quantityDelta: number): boolean {
    const available = this.getAvailableQuantity(item);
    const inCart = this.getCartQuantity(item.id);
    return inCart + quantityDelta <= available + 0.000001;
  }

  private getAvailableQuantity(item: Item): number {
    const quantity = item.quantity;
    if (typeof quantity !== 'number' || Number.isNaN(quantity)) {
      return 0;
    }
    return Math.max(0, quantity);
  }

  private getCartQuantity(itemId: string): number {
    return this.cart()
      .filter((x) => x.item.id === itemId)
      .reduce((sum, x) => sum + x.quantity, 0);
  }

  private showStockLimit(item: Item): void {
    const available = this.getAvailableQuantity(item);
    this.snackBar.open(`Maximal verfügbar für '${item.name}': ${available}`, 'OK', { duration: 2500 });
  }

  private ensureCartWithinStock(): boolean {
    const totalsByItem = new Map<string, { name: string; requested: number; available: number }>();

    for (const line of this.cart()) {
      const liveItem = this.items().find((item) => item.id === line.item.id) ?? line.item;
      const existing = totalsByItem.get(line.item.id);
      if (existing) {
        existing.requested = roundQuantity(existing.requested + line.quantity);
        continue;
      }

      totalsByItem.set(line.item.id, {
        name: line.item.name,
        requested: line.quantity,
        available: this.getAvailableQuantity(liveItem),
      });
    }

    for (const entry of totalsByItem.values()) {
      if (entry.requested > entry.available + 0.000001) {
        this.snackBar.open(
          `Bestand geändert: '${entry.name}' hat nur noch ${entry.available}. Warenkorb wurde aktualisiert.`,
          'OK',
          { duration: 3000 }
        );
        this.syncCartWithAvailability(false);
        return false;
      }
    }
    return true;
  }

  private syncCartWithAvailability(showNotification: boolean = true): void {
    const latestById = new Map(this.items().map((item) => [item.id, item] as const));
    const remainingById = new Map<string, number>();
    let changed = false;

    this.cart.update((current) => {
      const next: CartLine[] = [];

      for (const line of current) {
        const latestItem = latestById.get(line.item.id);
        if (!latestItem) {
          changed = true;
          continue;
        }

        if (!remainingById.has(line.item.id)) {
          remainingById.set(line.item.id, this.getAvailableQuantity(latestItem));
        }

        const remaining = remainingById.get(line.item.id) ?? 0;
        const nextQuantity = Math.min(line.quantity, remaining);
        remainingById.set(line.item.id, roundQuantity(Math.max(0, remaining - nextQuantity)));

        if (nextQuantity <= 0) {
          changed = true;
          continue;
        }

        if (nextQuantity !== line.quantity || latestItem.quantity !== line.item.quantity) {
          changed = true;
        }

        next.push({
          ...line,
          item: latestItem,
          quantity: nextQuantity,
        });
      }

      return next;
    });

    if (changed && showNotification) {
      this.snackBar.open('Warenkorb wurde mit aktuellem Bestand synchronisiert.', 'OK', { duration: 2200 });
    }
  }

  private buildOrderAnswersSignature(orderAnswers: Record<string, any>): string {
    const normalized: Record<string, string | boolean> = {};

    for (const key of Object.keys(orderAnswers).sort()) {
      const value = orderAnswers[key];
      if (typeof value === 'boolean') {
        normalized[key] = value;
        continue;
      }

      if (typeof value === 'string') {
        normalized[key] = value.trim();
        continue;
      }

      normalized[key] = String(value);
    }

    return JSON.stringify(normalized);
  }

  private createCartLineId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private stripHtml(value: string): string {
    return value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  }
}

function roundQuantity(value: number): number {
  return Math.round(value * 1000) / 1000;
}
