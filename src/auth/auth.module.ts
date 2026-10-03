import { Module } from '@nestjs/common';
import { JwtVerifier } from './jwt-verifier';

/** Token verification. The global AuthGuard itself is registered in AppModule to control guard order. */
@Module({
  providers: [JwtVerifier],
  exports: [JwtVerifier],
})
export class AuthModule {}
