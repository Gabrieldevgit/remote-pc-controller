package com.remotepccontroller.phonehost

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers [PhoneHostModule]. Uses BaseReactPackage (lazy, by name): a
 * plain legacy ReactPackage here broke the TurboModule registry in
 * bridgeless mode ("RNCClipboard could not be found" at startup).
 */
class PhoneHostPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == NAME) PhoneHostModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      NAME to ReactModuleInfo(
        NAME,
        PhoneHostModule::class.java.name,
        false, // canOverrideExistingModule
        false, // needsEagerInit
        false, // isCxxModule
        false, // isTurboModule (legacy module through the interop layer)
      ),
    )
  }

  companion object {
    const val NAME = "PhoneHost"
  }
}
