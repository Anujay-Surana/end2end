import Foundation
import Security

/// Service for secure storage and retrieval of sensitive data using iOS Keychain
class KeychainService {
    static let shared = KeychainService()
    
    private let serviceName = "com.kordn8.shadow"
    
    private init() {}
    
    /// Store a value in the keychain
    /// - Parameters:
    ///   - value: The string value to store
    ///   - key: The key identifier
    /// - Returns: True if successful, false otherwise
    func store(_ value: String, forKey key: String) -> Bool {
        guard let data = value.data(using: .utf8) else {
            return false
        }
        
        // Delete existing item if it exists
        delete(forKey: key)
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        
        let status = SecItemAdd(query as CFDictionary, nil)
        return status == errSecSuccess
    }
    
    /// Retrieve a value from the keychain
    /// - Parameter key: The key identifier
    /// - Returns: The stored value, or nil if not found
    func retrieve(forKey key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            return nil
        }
        
        return value
    }
    
    /// Delete a value from the keychain
    /// - Parameter key: The key identifier
    /// - Returns: True if successful, false otherwise
    func delete(forKey key: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key
        ]
        
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
    
    /// Check if a key exists in the keychain
    /// - Parameter key: The key identifier
    /// - Returns: True if the key exists, false otherwise
    func exists(forKey key: String) -> Bool {
        return retrieve(forKey: key) != nil
    }
    
    /// Clear all stored values from the keychain
    func clearAll() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName
        ]
        
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - Convenience Methods for Specific Keys
extension KeychainService {
    /// Store access token
    func storeAccessToken(_ token: String) -> Bool {
        return store(token, forKey: "access_token")
    }
    
    /// Retrieve access token
    func getAccessToken() -> String? {
        return retrieve(forKey: "access_token")
    }
    
    /// Store session token
    func storeSessionToken(_ token: String) -> Bool {
        return store(token, forKey: "session_token")
    }
    
    /// Retrieve session token
    func getSessionToken() -> String? {
        return retrieve(forKey: "session_token")
    }
    
    /// Delete access token
    func deleteAccessToken() -> Bool {
        return delete(forKey: "access_token")
    }
    
    /// Delete session token
    func deleteSessionToken() -> Bool {
        return delete(forKey: "session_token")
    }
    
    /// Clear all authentication tokens
    func clearAuthTokens() {
        deleteAccessToken()
        deleteSessionToken()
    }
}

