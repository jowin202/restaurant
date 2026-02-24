import { CanActivateFn, Router } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from './services/auth.services';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, map, take } from 'rxjs';

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return toObservable(auth.ready).pipe(
    filter(r => r === true),   // warten bis Auth geladen ist
    take(1),
    map(() => {
      return auth.logged_in()
        ? true
        : router.createUrlTree(['/login']);
    })
  );
};



export const authGuardAdmin: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return toObservable(auth.ready).pipe(
    filter(r => r === true),
    take(1),
    map(() => {
      return (auth.logged_in() && auth.admin_level() > 0)
        ? true
        : router.createUrlTree(['/login']);
    })
  );
};


export const authGuardSuperAdmin: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return toObservable(auth.ready).pipe(
    filter(r => r === true),
    take(1),
    map(() => {
      return (auth.logged_in() && auth.admin_level() > 1)
        ? true
        : router.createUrlTree(['/']);
    })
  );
};


export const authGuardUser: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return toObservable(auth.ready).pipe(
    filter(r => r === true),
    take(1),
    map(() => {
      return (auth.logged_in() && auth.admin_level() === 0)
        ? true
        : router.createUrlTree(['/']);
    })
  );
};
