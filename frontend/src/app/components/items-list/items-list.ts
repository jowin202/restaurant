import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.services';
import { YesNoDialog } from '../yes-no-dialog/yes-no-dialog';

type ItemType = 'essen' | 'getränk';

interface Item {
  id: string;
  name: string;
  item_type: ItemType;
  attributes: Record<string, any>;
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
    CommonModule,
    RouterModule,
    MatCardModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatDialogModule,
    MatSnackBarModule,
  ],
  templateUrl: './items-list.html',
  styleUrls: ['./items-list.css'],
})
export class ItemsList implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  loading = signal(true);
  searchText = signal('');

  dashboardData = signal<DashboardData | null>(null);
  items = signal<Item[]>([]);

  visibleItems = computed(() => {
    const search = this.searchText().trim().toLowerCase();
    if (!search) return this.items();

    return this.items().filter((item) => {
      const inName = item.name.toLowerCase().includes(search);
      const inType = item.item_type.toLowerCase().includes(search);
      const inEan = (item.ean || '').toLowerCase().includes(search);
      const inAttrs = Object.entries(item.attributes || {}).some(
        ([k, v]) => `${k} ${JSON.stringify(v)}`.toLowerCase().includes(search)
      );
      return inName || inType || inEan || inAttrs;
    });
  });

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

  onSearchChange(value: string): void {
    this.searchText.set(value);
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

  private isApiError(response: any): boolean {
    return Array.isArray(response) && response.length > 0 && response[0]?.error_code !== undefined;
  }
}
