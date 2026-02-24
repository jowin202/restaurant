import { Component, OnInit, computed, inject, signal } from '@angular/core';
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
  in_stock: boolean;
  quantity: number | null;
  unit: string | null;
  image_data_url?: string | null;
  image_data_urls?: string[];
  order_attributes?: OrderAttributeDefinition[];
}

interface CartLine {
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
export class Shop implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);

  loading = signal(true);
  ordering = signal(false);

  search = signal('');
  typeFilter = signal<'all' | ItemType>('all');

  items = signal<Item[]>([]);
  cart = signal<CartLine[]>([]);

  visibleItems = computed(() => {
    const search = this.search().trim().toLowerCase();
    const type = this.typeFilter();

    return this.items().filter((item) => {
      if (type !== 'all' && item.item_type !== type) return false;
      if (!search) return true;
      return item.name.toLowerCase().includes(search);
    });
  });

  cartCount = computed(() => this.cart().reduce((sum, line) => sum + line.quantity, 0));

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);
    this.api.get('/api/items/?include_images=true&in_stock=true', this.auth.token()).subscribe((res: any) => {
      this.loading.set(false);

      if (this.isApiError(res)) {
        this.items.set([]);
        this.snackBar.open('Shop-Daten konnten nicht geladen werden.', 'OK', { duration: 2500 });
        return;
      }

      this.items.set(res as Item[]);
    });
  }

  setTypeFilter(value: 'all' | ItemType): void {
    this.typeFilter.set(value);
  }

  setSearch(value: string): void {
    this.search.set(value);
  }

  addToCart(item: Item): void {
    const orderAttributes = this.getOrderAttributes(item);
    if (orderAttributes.length === 0) {
      this.upsertCartLine(item, {}, 1);
      return;
    }

    const existing = this.cart().find((line) => line.item.id === item.id);
    this.dialog
      .open(OrderAttributesDialog, {
        width: '640px',
        data: {
          itemName: item.name,
          attributes: orderAttributes,
          initialAnswers: existing?.order_answers ?? {},
        },
      })
      .afterClosed()
      .subscribe((answers: Record<string, any> | null | undefined) => {
        if (!answers) return;
        this.upsertCartLine(item, answers, 1);
      });
  }

  increment(line: CartLine): void {
    this.cart.update((current) =>
      current.map((x) => (x.item.id === line.item.id ? { ...x, quantity: x.quantity + 1 } : x))
    );
  }

  decrement(line: CartLine): void {
    this.cart.update((current) => {
      const next = current
        .map((x) => (x.item.id === line.item.id ? { ...x, quantity: x.quantity - 1 } : x))
        .filter((x) => x.quantity > 0);
      return next;
    });
  }

  remove(line: CartLine): void {
    this.cart.update((current) => current.filter((x) => x.item.id !== line.item.id));
  }

  editAnswers(line: CartLine): void {
    const orderAttributes = this.getOrderAttributes(line.item);
    if (orderAttributes.length === 0) {
      return;
    }

    this.dialog
      .open(OrderAttributesDialog, {
        width: '640px',
        data: {
          itemName: line.item.name,
          attributes: orderAttributes,
          initialAnswers: line.order_answers,
        },
      })
      .afterClosed()
      .subscribe((answers: Record<string, any> | null | undefined) => {
        if (!answers) return;

        this.cart.update((current) =>
          current.map((x) => (x.item.id === line.item.id ? { ...x, order_answers: answers } : x))
        );
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

    const payload = {
      items: this.cart().map((line) => ({
        item_id: line.item.id,
        quantity: line.quantity,
        order_answers: line.order_answers,
      })),
    };

    this.ordering.set(true);
    this.api.post('/api/orders/checkout/', this.auth.token(), payload).subscribe((res: any) => {
      this.ordering.set(false);

      if (this.isApiError(res)) {
        this.snackBar.open('Bestellung fehlgeschlagen.', 'OK', { duration: 2500 });
        return;
      }

      this.cart.set([]);
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
    this.cart.update((current) => {
      const index = current.findIndex((line) => line.item.id === item.id);
      if (index === -1) {
        return [...current, { item, quantity: quantityDelta, order_answers: orderAnswers }];
      }

      const clone = [...current];
      clone[index] = {
        ...clone[index],
        quantity: clone[index].quantity + quantityDelta,
        order_answers: Object.keys(orderAnswers).length > 0 ? orderAnswers : clone[index].order_answers,
      };
      return clone;
    });
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
}
