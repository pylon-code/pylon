import { BlurTargetView } from "expo-blur";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation } from "@react-navigation/native";

import { RegistryContext } from "@effect/atom-react";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import { IncomingShareProvider } from "./features/sharing/IncomingShareProvider";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { OverlayPortalHost } from "./components/OverlayPortal";
import { useUniwindTheme } from "./lib/useUniwindTheme";
import { appBlurTargetRef } from "./lib/appBlurTarget";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { shouldHandleAppLink } from "./lib/appLinking";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {
  // The native module can be unavailable in non-native test environments.
});

const appLinking = {
  // `createURL` covers the running variant's own scheme; the rest are listed so a
  // link minted for one variant still resolves in another. They must match the
  // schemes `app.config.ts` registers, because iOS never delivers an
  // unregistered scheme to the app.
  prefixes: [Linking.createURL("/"), "pylon-code://", "pylon-code-dev://", "pylon-code-preview://"],
  filter: shouldHandleAppLink,
};

const Navigation = createStaticNavigation(RootStack);

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();

  useEffect(() => {
    if (isReady) void SplashScreen.hide();
  }, [isReady]);

  return null;
}

export default function App() {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <AppearancePreferencesProvider>
          <AppContent />
        </AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}

function AppContent() {
  const { themeAppearance } = useAppearancePreferences();
  const statusBarColor = String(useUniwindTheme()["--color-status-bar"]);
  const navigationTheme = useMobileNavigationTheme();

  return (
    <>
      <SplashScreenCoordinator />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <StatusBar
              barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"}
              // Android draws under a translucent bar, so dropping the colour
              // left the scrim off and orphaned `--color-status-bar`. iOS
              // ignores this prop.
              backgroundColor={statusBarColor}
              translucent
            />
            {/* The navigation theme drives the NATIVE header appearance: native-stack
                forwards `dark` as the nav bar's overrideUserInterfaceStyle. Without
                this, React Navigation defaults to its light theme and every native
                header (glass buttons, title, materials) is forced light even when
                the system is in dark mode. */}
            {/* Blur target for Android dropdown backdrops — see appBlurTarget.ts. */}
            <BlurTargetView ref={appBlurTargetRef} style={{ flex: 1 }}>
              <IncomingShareProvider>
                <Navigation linking={appLinking} theme={navigationTheme} />
              </IncomingShareProvider>
              <ConfirmDialogHost />
              <ThreadArrangementHost />
            </BlurTargetView>
            {/* Anchored-menu overlays render here — in-window, so the
                keyboard stays up while a dropdown is open. */}
            <OverlayPortalHost />
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
