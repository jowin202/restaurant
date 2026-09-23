import { Component, effect, inject, ChangeDetectionStrategy } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.services';

@Component({
  selector: 'app-role-home',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Eager,
  template: ''
})
export class RoleHome {
  private auth = inject(AuthService);
  private router = inject(Router);

  constructor() {
    effect(() => {
      if (!this.auth.logged_in()) return;

      const level = this.auth.admin_level();

      if (level <= 0) {
        this.router.navigate(['/shop']);
        return;
      }

      this.router.navigate(['/items/list']);
    });
  }
}
