import { Component, OnInit, computed, inject, signal, WritableSignal, ChangeDetectionStrategy } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';
import { YesNoDialog } from '../yes-no-dialog/yes-no-dialog';

type ItemType = 'essen' | 'getränk';

interface Item {
  id: string;
  name: string;
  item_type: ItemType;
  description_html?: string | null;
  price_eur?: number | null;
  quantity: number | null;
  unit: string | null;
  ean?: string | null;
  has_image: boolean;
  image_data_url?: string | null;
  image_data_urls?: string[];
}

interface DashboardData {
  summary: {
    total_items: number;
    total_food: number;
    total_drinks: number;
    total_with_images: number;
  };
  alerts: {
    low_stock: Array<{ id: string; name: string; quantity: number | null; unit: string | null }>;
  };
}

@Component({
  selector: 'app-items-list',
  standalone: true,
  imports: [
    FormsModule,
    RouterModule,
    MatCardModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatDialogModule,
    MatSnackBarModule,
    MatTooltipModule,
],
  templateUrl: './items-list.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./items-list.css'],
})
export class ItemsList implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  loading = signal(true);
  foodSearchText = signal('');
  drinkSearchText = signal('');

  printingItems = signal<Set<string>>(new Set());
  printCounts: Record<string, number> = {};

  dashboardData = signal<DashboardData | null>(null);
  items = signal<Item[]>([]);

  foodItems = computed(() => this.itemsByTypeAndSearch('essen', this.foodSearchText()));
  drinkItems = computed(() => this.itemsByTypeAndSearch('getränk', this.drinkSearchText()));

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading.set(true);

    this.api.get('/api/dashboard/', this.auth.token()).subscribe((dashboardRes: any) => {
      if (!this.isApiError(dashboardRes)) {
        this.dashboardData.set(dashboardRes);
      }
    });

    this.api.get('/api/items/?include_images=true', this.auth.token()).subscribe((itemsRes: any) => {
      this.loading.set(false);

      if (this.isApiError(itemsRes)) {
        this.items.set([]);
        this.snackBar.open('Items konnten nicht geladen werden.', 'OK', { duration: 2500 });
        return;
      }

      this.items.set(itemsRes as Item[]);
    });
  }

  onFoodSearchChange(value: string): void {
    this.foodSearchText.set(value);
  }

  onDrinkSearchChange(value: string): void {
    this.drinkSearchText.set(value);
  }

  remove(item: Item): void {
    this.dialog.open(YesNoDialog, {
      width: 'min(92vw, 420px)',
      maxWidth: '92vw',
      data: {
        head: 'Item löschen',
        body: `Soll "${item.name}" wirklich gelöscht werden?`,
      },
    }).afterClosed().subscribe((confirmed: boolean) => {
      if (!confirmed) return;

      this.api.delete(`/api/items/${item.id}/`, this.auth.token()).subscribe((res: any) => {
        if (this.isApiError(res)) {
          this.snackBar.open('Löschen fehlgeschlagen.', 'OK', { duration: 2500 });
          return;
        }
        this.snackBar.open('Item gelöscht.', 'OK', { duration: 2000 });
        this.reload();
      });
    });
  }

  removeImage(item: Item): void {
    this.dialog.open(YesNoDialog, {
      width: 'min(92vw, 420px)',
      maxWidth: '92vw',
      data: {
        head: 'Bild entfernen',
        body: `Soll das Bild von "${item.name}" wirklich entfernt werden?`,
      },
    }).afterClosed().subscribe((confirmed: boolean) => {
      if (!confirmed) return;

      this.api.delete(`/api/items/${item.id}/image/`, this.auth.token()).subscribe((res: any) => {
        if (this.isApiError(res)) {
          this.snackBar.open('Bild konnte nicht gelöscht werden.', 'OK', { duration: 2500 });
          return;
        }
        this.snackBar.open('Bild entfernt.', 'OK', { duration: 2000 });
        this.reload();
      });
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

  formatPrice(value: number | null | undefined): string {
    const numeric = Number(value ?? 0);
    const rounded = Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
    return `${rounded.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`;
  }

  private stripHtml(value: string): string {
    return value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  getPrintCount(item: Item): number {
    return this.printCounts[item.id] ?? 1;
  }

  setPrintCount(item: Item, value: number): void {
    this.printCounts[item.id] = Math.max(1, Math.min(100, value || 1));
  }

  isPrinting(item: Item): boolean {
    return this.printingItems().has(item.id);
  }

  printLabel(item: Item): void {
    const count = this.getPrintCount(item);
    const printing = new Set(this.printingItems());
    printing.add(item.id);
    this.printingItems.set(printing);

    this.api.post(`/api/items/${item.id}/print-label/?count=${count}`, this.auth.token(), {}).subscribe({
      next: (res: any) => {
        const done = new Set(this.printingItems());
        done.delete(item.id);
        this.printingItems.set(done);

        if (this.isApiError(res) || res?.detail) {
          const msg = res?.detail || 'Drucken fehlgeschlagen.';
          this.snackBar.open(msg, 'OK', { duration: 3000 });
          return;
        }
        this.snackBar.open(`${count} Etikett${count !== 1 ? 'en' : ''} gedruckt.`, 'OK', { duration: 2000 });
      },
      error: (err: any) => {
        const done = new Set(this.printingItems());
        done.delete(item.id);
        this.printingItems.set(done);
        const msg = err?.error?.detail || 'Drucker nicht erreichbar.';
        this.snackBar.open(msg, 'OK', { duration: 3000 });
      },
    });
  }

  private isApiError(response: any): boolean {
    return Array.isArray(response) && response.length > 0 && response[0]?.error_code !== undefined;
  }

  private itemsByTypeAndSearch(type: ItemType, searchText: string): Item[] {
    const search = searchText.trim().toLowerCase();
    return this.items().filter((item) => {
      if (item.item_type !== type) return false;
      if (!search) return true;

      const inName = item.name.toLowerCase().includes(search);
      const inType = item.item_type.toLowerCase().includes(search);
      const inEan = (item.ean || '').toLowerCase().includes(search);
      const inDescription = this.stripHtml(item.description_html || '').toLowerCase().includes(search);
      return inName || inType || inEan || inDescription;
    });
  }
}
